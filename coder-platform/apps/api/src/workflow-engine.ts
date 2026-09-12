import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Workflow engine.
 * Steps run in order and share a context. Supported step types:
 * prompt (runs the agent engine), condition (jump when false), branch (jump on first match),
 * approval (pauses until a human decides), delay (waits, then continues).
 */
export type WorkflowStep = {
  id?: string;
  name?: string;
  type: "prompt" | "condition" | "branch" | "approval" | "delay";
  prompt?: string;
  value?: string;
  field?: string;
  op?: string;
  goto?: string;
  cases?: { field?: string; op?: string; value?: string; goto?: string }[];
  default?: string;
  seconds?: number;
};

export type WorkflowContext = {
  input: string;
  last: string;
  steps: Record<string, string>;
};

export const COMPARISON_OPS = ["==", "!=", ">", "<", ">=", "<=", "contains", "notContains", "exists", "empty"] as const;

export function resolvePath(context: WorkflowContext, path?: string): string {
  if (!path) return "";
  const clean = path.trim();
  if (clean === "input") return context.input;
  if (clean === "last") return context.last;
  if (clean.startsWith("steps.")) return context.steps[clean.slice(6)] ?? "";
  return "";
}

export function compare(left: string, op: string, right = ""): boolean {
  const l = (left ?? "").trim();
  const r = (right ?? "").trim();
  const ln = Number(l);
  const rn = Number(r);
  const numeric = l !== "" && r !== "" && !Number.isNaN(ln) && !Number.isNaN(rn);
  switch (op) {
    case "==": return l === r;
    case "!=": return l !== r;
    case ">": return numeric ? ln > rn : l > r;
    case "<": return numeric ? ln < rn : l < r;
    case ">=": return numeric ? ln >= rn : l >= r;
    case "<=": return numeric ? ln <= rn : l <= r;
    case "contains": return r === "" ? false : l.includes(r);
    case "notContains": return r === "" ? true : !l.includes(r);
    case "exists": return l !== "";
    case "empty": return l === "";
    default: throw new Error(`UNSUPPORTED_OPERATOR:${op}`);
  }
}

export function evaluateCondition(context: WorkflowContext, field?: string, op = "==", value?: string): boolean {
  return compare(resolvePath(context, field), op, value ?? "");
}

export function renderTemplate(text: string, context: WorkflowContext): string {
  return String(text ?? "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => resolvePath(context, key));
}

export type StepRunner = (prompt: string) => Promise<string>;

function nowIso() { return new Date().toISOString(); }

export function recordAudit(workspaceId: string | null, actorUserId: string | null, action: string, metadata: Record<string, unknown>) {
  try {
    db.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), workspaceId, actorUserId, action, JSON.stringify(metadata), nowIso());
  } catch { /* audit must never break the request */ }
}

type ExecutionRow = {
  id: string; workflow_id: string; project_id: string; status: string; input: string;
  current_step: number; cancel_requested: number; context_json: string; attempt: number;
};
type StepRow = { id: string; type: string };

function loadExecution(executionId: string) {
  return db.prepare("SELECT id, workflow_id, project_id, status, input, current_step, cancel_requested, context_json, attempt FROM workflow_executions WHERE id=?").get(executionId) as ExecutionRow | undefined;
}

function workspaceOfProject(projectId: string) {
  return (db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(projectId) as { workspaceId: string } | undefined)?.workspaceId ?? null;
}

function upsertStep(executionId: string, index: number, stepId: string, type: string, input: string) {
  const existing = db.prepare("SELECT id, type FROM workflow_execution_steps WHERE execution_id=? AND step_index=?").get(executionId, index) as StepRow | undefined;
  if (existing) {
    db.prepare("UPDATE workflow_execution_steps SET status='running', input=?, started_at=?, output='', error=NULL WHERE id=?").run(input, nowIso(), existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO workflow_execution_steps (id,execution_id,step_index,step_id,type,status,input,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, executionId, index, stepId, type, "running", input, nowIso());
  return id;
}

function finishStep(stepRowId: string, status: string, output: string, error?: string | null) {
  db.prepare("UPDATE workflow_execution_steps SET status=?, output=?, error=?, finished_at=? WHERE id=?").run(status, output, error ?? null, nowIso(), stepRowId);
}

export function stepIdOf(step: WorkflowStep, index: number) { return step.id && step.id.trim() ? step.id.trim() : `step-${index + 1}`; }

function findIndexById(steps: WorkflowStep[], id?: string) {
  if (!id) return -1;
  return steps.findIndex((step, index) => stepIdOf(step, index) === id);
}

const MAX_DELAY_SECONDS = 900;

/**
 * Runs a stored execution to the end, or until it pauses on an approval step.
 * Safe to call repeatedly: it continues from the stored current_step.
 */
export async function runExecution(executionId: string, runner: StepRunner): Promise<{ status: string }> {
  const execution = loadExecution(executionId);
  if (!execution) return { status: "missing" };
  const workflow = db.prepare("SELECT id, steps_json AS stepsJson FROM workflows WHERE id=?").get(execution.workflow_id) as { id: string; stepsJson: string } | undefined;
  if (!workflow) {
    db.prepare("UPDATE workflow_executions SET status='failed', error='WORKFLOW_NOT_FOUND', finished_at=? WHERE id=?").run(nowIso(), executionId);
    return { status: "failed" };
  }
  const steps = JSON.parse(workflow.stepsJson) as WorkflowStep[];
  const workspaceId = workspaceOfProject(execution.project_id);
  const context: WorkflowContext = execution.context_json && execution.context_json !== "{}"
    ? JSON.parse(execution.context_json) as WorkflowContext
    : { input: execution.input, last: "", steps: {} };
  context.input = context.input ?? execution.input;
  context.steps = context.steps ?? {};

  db.prepare("UPDATE workflow_executions SET status='running', started_at=COALESCE(started_at,?) WHERE id=?").run(nowIso(), executionId);

  let index = execution.current_step ?? 0;
  while (index < steps.length) {
    const fresh = loadExecution(executionId);
    if (!fresh) return { status: "missing" };
    if (fresh.cancel_requested || fresh.status === "cancelling") {
      db.prepare("UPDATE workflow_executions SET status='cancelled', finished_at=?, context_json=? WHERE id=?").run(nowIso(), JSON.stringify(context), executionId);
      recordAudit(workspaceId, null, "workflow.execution.cancelled", { executionId });
      return { status: "cancelled" };
    }
    const step = steps[index];
    const stepId = stepIdOf(step, index);
    const type = step?.type ?? "prompt";
    const stepRowId = upsertStep(executionId, index, stepId, type, step?.prompt ?? step?.value ?? "");
    try {
      if (type === "prompt") {
        const promptText = renderTemplate(step.prompt ?? step.value ?? "", context);
        let output = "";
        try {
          output = await runner(promptText);
        } catch (error) {
          throw new Error(`STEP_PROMPT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
        }
        context.steps[stepId] = output;
        context.last = output;
        finishStep(stepRowId, "completed", output);
        index += 1;
      } else if (type === "condition") {
        const passed = evaluateCondition(context, step.field, step.op ?? "==", step.value);
        const output = JSON.stringify({ field: step.field, op: step.op ?? "==", value: step.value ?? "", passed });
        finishStep(stepRowId, "completed", output);
        const target = passed ? -1 : findIndexById(steps, step.goto);
        if (!passed && target < 0) throw new Error("CONDITION_GOTO_NOT_FOUND");
        index = passed ? index + 1 : target;
      } else if (type === "branch") {
        const matched = (step.cases ?? []).find((item) => evaluateCondition(context, item.field, item.op ?? "==", item.value));
        const targetId = matched ? matched.goto : step.default;
        const target = findIndexById(steps, targetId);
        finishStep(stepRowId, "completed", JSON.stringify({ matched: matched?.goto ?? null, target: targetId ?? null }));
        if (target < 0) throw new Error("BRANCH_GOTO_NOT_FOUND");
        index = target;
      } else if (type === "approval") {
        db.prepare("UPDATE workflow_executions SET status='awaiting_approval', approval_status='pending', current_step=?, context_json=?, cancel_requested=0 WHERE id=?")
          .run(index, JSON.stringify(context), executionId);
        finishStep(stepRowId, "waiting", step.value ?? step.prompt ?? "Menunggu persetujuan");
        recordAudit(workspaceId, null, "workflow.execution.awaiting_approval", { executionId, stepId });
        return { status: "awaiting_approval" };
      } else if (type === "delay") {
        const seconds = Math.min(Math.max(Number(step.seconds ?? 0), 0), MAX_DELAY_SECONDS);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        finishStep(stepRowId, "completed", JSON.stringify({ waitedSeconds: seconds }));
        index += 1;
      } else {
        throw new Error(`UNSUPPORTED_STEP_TYPE:${type}`);
      }
      db.prepare("UPDATE workflow_executions SET current_step=?, context_json=?, cancel_requested=0 WHERE id=?").run(index, JSON.stringify(context), executionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishStep(stepRowId, "failed", "", message);
      db.prepare("UPDATE workflow_executions SET status='failed', error=?, finished_at=?, context_json=? WHERE id=?").run(message, nowIso(), JSON.stringify(context), executionId);
      recordAudit(workspaceId, null, "workflow.execution.failed", { executionId, stepId, message });
      return { status: "failed" };
    }
  }
  const output = JSON.stringify({ input: context.input, steps: context.steps, last: context.last });
  db.prepare("UPDATE workflow_executions SET status='completed', output=?, finished_at=?, current_step=?, context_json=? WHERE id=?").run(output, nowIso(), steps.length, JSON.stringify(context), executionId);
  recordAudit(workspaceId, null, "workflow.execution.completed", { executionId, steps: steps.length });
  return { status: "completed" };
}

/** Creates an execution row and starts it. Returns the execution id. */
export function createExecution(workflowId: string, input: string, actorUserId: string | null) {
  const workflow = db.prepare("SELECT id, project_id AS projectId FROM workflows WHERE id=?").get(workflowId) as { id: string; projectId: string } | undefined;
  if (!workflow) return null;
  const id = randomUUID();
  const now = nowIso();
  db.prepare("INSERT INTO workflow_executions (id,workflow_id,project_id,status,input,created_at) VALUES (?,?,?,?,?,?)").run(id, workflow.id, workflow.projectId, "queued", input, now);
  recordAudit(workspaceOfProject(workflow.projectId), actorUserId, "workflow.execution.started", { executionId: id, workflowId });
  return id;
}

export function scheduleNextRun(workflowId: string, intervalMinutes: number | null, lastRunAt = new Date()) {
  const next = intervalMinutes && intervalMinutes > 0 ? new Date(lastRunAt.getTime() + intervalMinutes * 60_000).toISOString() : null;
  db.prepare("UPDATE workflows SET last_run_at=?, next_run_at=? WHERE id=?").run(lastRunAt.toISOString(), next, workflowId);
  return next;
}
