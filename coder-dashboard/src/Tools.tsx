import { useEffect, useMemo, useState } from 'react';
import { api, type Artifact, type AuditEvent, type ExecutionDetail, type Invitation, type KnowledgeDocument, type KnowledgeHit, type Member, type Workflow, type WorkflowExecution, type WorkflowStep } from './api';

const STEP_TYPES: WorkflowStep['type'][] = ['prompt', 'condition', 'branch', 'approval', 'delay'];
const TERMINAL = ['completed', 'failed', 'cancelled'];

function newStep(type: WorkflowStep['type']): WorkflowStep {
  const id = `${type}-${Math.random().toString(36).slice(2, 6)}`;
  if (type === 'prompt') return { id, type, prompt: 'Tulis instruksi. Gunakan {{input}} atau {{last}}.' };
  if (type === 'condition') return { id, type, field: 'last', op: 'contains', value: '', goto: '' };
  if (type === 'branch') return { id, type, cases: [{ field: 'last', op: 'contains', value: '', goto: '' }], default: '' };
  if (type === 'approval') return { id, type, value: 'Menunggu persetujuan' };
  return { id, type, seconds: 5 };
}

export function Tools({ projectId, workspaceId, onClose }: { projectId: string; workspaceId: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<'knowledge' | 'workflow' | 'team' | 'artifacts' | 'audit'>('knowledge');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // Knowledge base state
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [query, setQuery] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');

  // Workflow state
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftSteps, setDraftSteps] = useState<WorkflowStep[]>([]);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [executionDetail, setExecutionDetail] = useState<ExecutionDetail | null>(null);
  const [runInput, setRunInput] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);

  // Team state
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteLink, setInviteLink] = useState('');

  // Artifact state
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  // Audit state
  const [audit, setAudit] = useState<AuditEvent[]>([]);

  function patch(index: number, patchValue: Partial<WorkflowStep>) { setDraftSteps((steps) => patchSteps(steps, index, patchValue)); }
  function patchCase(index: number, caseIndex: number, patchValue: { field?: string; value?: string; goto?: string }) { setDraftSteps((steps) => patchCaseSteps(steps, index, caseIndex, patchValue)); }

  const selected = useMemo(() => workflows.find((item) => item.id === selectedId) ?? null, [workflows, selectedId]);

  async function guard(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function loadKnowledge() { setDocuments(await api.knowledge(projectId)); }
  async function loadWorkflows() { setWorkflows(await api.workflows(projectId)); }
  async function loadAudit() { if (workspaceId) setAudit(await api.auditEvents(workspaceId)); }
  async function loadTeam() { if (!workspaceId) return; setMembers(await api.members(workspaceId)); setInvitations(await api.invitations(workspaceId)); }
  async function loadArtifacts() { setArtifacts(await api.artifacts(projectId)); }

  /** Reads a picked file as Base64 and uploads it as a knowledge document. */
  async function uploadDocument(file: File) {
    setUploading(true); setMessage('');
    try {
      const base64 = await readBase64(file);
      const created = await api.uploadKnowledge(projectId, file.name, base64);
      await loadKnowledge();
      setMessage(`${created.title} tersimpan (${created.chunkCount ?? 0} bagian, ${created.sourceType}).`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  }

  async function uploadArtifactFile(file: File) {
    setUploading(true); setMessage('');
    try {
      await api.uploadArtifact(projectId, file.name, file.type || 'application/octet-stream', await readBase64(file));
      await loadArtifacts(); setMessage(`${file.name} diunggah sebagai artifact.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  }

  useEffect(() => {
    void guard(async () => {
      if (tab === 'knowledge') await loadKnowledge();
      else if (tab === 'workflow') await loadWorkflows();
      else if (tab === 'team') await loadTeam();
      else if (tab === 'artifacts') await loadArtifacts();
      else await loadAudit();
    });
  }, [tab, projectId, workspaceId]);

  function pickWorkflow(workflow: Workflow) {
    setSelectedId(workflow.id);
    setDraftName(workflow.name);
    setDraftSteps(Array.isArray(workflow.steps) ? workflow.steps : []);
    setExecutionDetail(null);
    setIntervalMinutes(workflow.intervalMinutes ?? 60);
    void guard(async () => setExecutions(await api.workflowExecutions(workflow.id)));
  }

  async function pollExecution(executionId: string) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const detail = await api.execution(executionId);
      setExecutionDetail(detail);
      if (TERMINAL.includes(detail.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (selectedId) setExecutions(await api.workflowExecutions(selectedId));
  }

  const knowledgeTab = (
    <div className="tool-body">
      <div className="tool-row wrap">
        <label className="file-picker">Pilih dokumen (txt, md, csv, json, pdf, docx)
          <input type="file" accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.pdf,.docx" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDocument(file); event.target.value = ''; }} />
        </label>
        {uploading && <small>Mengunggah dan mengekstrak…</small>}
      </div>
      <div className="tool-row">
        <input value={docTitle} onChange={(event) => setDocTitle(event.target.value)} placeholder="Judul dokumen teks" />
        <button type="button" className="primary" disabled={busy || !docTitle.trim()} onClick={() => void guard(async () => {
          await api.addKnowledge(projectId, docTitle.trim(), docContent);
          setDocTitle(''); setDocContent(''); await loadKnowledge(); setMessage('Catatan teks tersimpan dan diindeks.');
        })}>Simpan catatan</button>
      </div>
      <textarea value={docContent} onChange={(event) => setDocContent(event.target.value)} rows={4} placeholder="Isi catatan teks (juga dipakai sebagai konteks AI)" />
      <div className="tool-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari di knowledge base" />
        <button type="button" disabled={busy || !query.trim()} onClick={() => void guard(async () => setHits(await api.searchKnowledge(projectId, query.trim())))}>Cari</button>
      </div>
      {hits.length > 0 && (
        <div className="tool-list">
          {hits.map((hit) => (
            <div key={`${hit.documentId}-${hit.chunkIndex}`}>
              <b>{hit.title} · bagian {hit.chunkIndex + 1}</b>
              <small>{hit.content.slice(0, 220)}…</small>
            </div>
          ))}
        </div>
      )}
      <div className="tool-list">
        {documents.map((document) => (
          <div key={document.id}>
            <b>{document.title}</b>
            <small>{document.sourceType} · {document.chunkCount ?? 0} bagian · {String(document.checksum).slice(0, 10)}…</small>
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              await api.deleteKnowledge(projectId, document.id); await loadKnowledge(); setMessage('Dokumen dihapus.');
            })}>Hapus</button>
          </div>
        ))}
        {!documents.length && <small>Belum ada dokumen. Unggah PDF, DOCX, atau teks.</small>}
      </div>
    </div>
  );

  const workflowTab = (
    <div className="tool-body">
      <div className="tool-row">
        <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Nama workflow baru" />
        <button type="button" disabled={busy || !draftName.trim()} onClick={() => void guard(async () => {
          const created = await api.addWorkflow(projectId, draftName.trim(), [newStep('prompt')]) as Workflow;
          setDraftName(''); await loadWorkflows(); const list = await api.workflows(projectId); const found = list.find((item) => item.id === created.id); if (found) pickWorkflow(found); setMessage('Workflow dibuat.');
        })}>Buat workflow</button>
      </div>

      <div className="tool-list">
        {workflows.map((workflow) => (
          <div key={workflow.id} className={workflow.id === selectedId ? 'selected' : ''}>
            <b>{workflow.name}</b>
            <small>{workflow.status} · {workflow.steps?.length ?? 0} langkah{workflow.scheduleEnabled ? ` · tiap ${workflow.intervalMinutes} menit` : ''}</small>
            <button type="button" onClick={() => pickWorkflow(workflow)}>Buka</button>
          </div>
        ))}
        {!workflows.length && <small>Belum ada workflow.</small>}
      </div>

      {selected && (
        <div className="step-editor">
          <h3>{selected.name} <span className="badge">{selected.status}</span></h3>
          <div className="tool-row wrap">
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              await api.updateWorkflow(selected.id, { name: draftName, steps: draftSteps }); await loadWorkflows(); setMessage('Workflow disimpan.');
            })}>Simpan langkah</button>
            <button type="button" disabled={busy || selected.status === 'published'} onClick={() => void guard(async () => {
              await api.publishWorkflow(selected.id); await loadWorkflows(); setMessage('Workflow dipublikasikan.');
            })}>Publish</button>
          </div>

          {draftSteps.map((step, index) => (
            <div className="step-row" key={step.id ?? index}>
              <header>
                <strong>#{index + 1} {step.type}</strong>
                <span>
                  <button type="button" disabled={index === 0} onClick={() => setDraftSteps((steps) => move(steps, index, index - 1))}>↑</button>
                  <button type="button" disabled={index === draftSteps.length - 1} onClick={() => setDraftSteps((steps) => move(steps, index, index + 1))}>↓</button>
                  <button type="button" onClick={() => setDraftSteps((steps) => steps.filter((_, position) => position !== index))}>Hapus</button>
                </span>
              </header>
              <input value={step.id ?? ''} onChange={(event) => patch(index, { id: event.target.value })} placeholder="ID langkah" />
              <select value={step.type} onChange={(event) => setDraftSteps((steps) => steps.map((item, position) => position === index ? newStep(event.target.value as WorkflowStep['type']) : item))}>
                {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              {step.type === 'prompt' && <textarea rows={3} value={step.prompt ?? ''} onChange={(event) => patch(index, { prompt: event.target.value })} placeholder="Prompt langkah" />}
              {step.type === 'approval' && <input value={step.value ?? ''} onChange={(event) => patch(index, { value: event.target.value })} placeholder="Catatan approval" />}
              {step.type === 'delay' && <input type="number" min={0} max={900} value={step.seconds ?? 0} onChange={(event) => patch(index, { seconds: Number(event.target.value) })} placeholder="Detik" />}
              {step.type === 'condition' && (
                <>
                  <input value={step.field ?? ''} onChange={(event) => patch(index, { field: event.target.value })} placeholder="field (last, input, steps.<id>)" />
                  <select value={step.op ?? '=='} onChange={(event) => patch(index, { op: event.target.value })}>
                    {['==', '!=', '>', '<', '>=', '<=', 'contains', 'notContains', 'exists', 'empty'].map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  <input value={step.value ?? ''} onChange={(event) => patch(index, { value: event.target.value })} placeholder="nilai pembanding" />
                  <input value={step.goto ?? ''} onChange={(event) => patch(index, { goto: event.target.value })} placeholder="ID langkah tujuan jika gagal" />
                </>
              )}
              {step.type === 'branch' && (
                <>
                  {(step.cases ?? []).map((item, caseIndex) => (
                    <div className="case-row" key={caseIndex}>
                      <input value={item.field ?? ''} onChange={(event) => patchCase(index, caseIndex, { field: event.target.value })} placeholder="field" />
                      <input value={item.value ?? ''} onChange={(event) => patchCase(index, caseIndex, { value: event.target.value })} placeholder="nilai" />
                      <input value={item.goto ?? ''} onChange={(event) => patchCase(index, caseIndex, { goto: event.target.value })} placeholder="ID tujuan" />
                    </div>
                  ))}
                  <input value={step.default ?? ''} onChange={(event) => patch(index, { default: event.target.value })} placeholder="ID tujuan default" />
                </>
              )}
            </div>
          ))}

          <div className="tool-row wrap">
            {STEP_TYPES.map((type) => <button type="button" key={type} onClick={() => setDraftSteps((steps) => [...steps, newStep(type)])}>+ {type}</button>)}
          </div>

          <div className="tool-row wrap">
            <input value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder="Input workflow" />
            <button type="button" className="primary" disabled={busy} onClick={() => void guard(async () => {
              const started = await api.executeWorkflow(selected.id, runInput) as { id: string };
              setMessage('Workflow berjalan.'); await pollExecution(started.id);
            })}>Jalankan</button>
          </div>

          <div className="tool-row wrap">
            <label>Jadwal tiap <input type="number" min={1} max={20160} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /> menit</label>
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              const result = await api.scheduleWorkflow(selected.id, intervalMinutes, true); await loadWorkflows(); setMessage(`Jadwal aktif. Run berikutnya ${result.nextRunAt ?? '-'}.`);
            })}>Aktifkan jadwal</button>
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              await api.scheduleWorkflow(selected.id, null, false); await loadWorkflows(); setMessage('Jadwal dimatikan.');
            })}>Matikan jadwal</button>
          </div>

          <div className="tool-list">
            {executions.map((execution) => (
              <div key={execution.id}>
                <b>{execution.status}</b>
                <small>percobaan {execution.attempt} · {execution.approvalStatus} · {new Date(execution.createdAt).toLocaleString('id-ID')}</small>
                <button type="button" onClick={() => void guard(async () => setExecutionDetail(await api.execution(execution.id)))}>Detail</button>
                <button type="button" disabled={busy || TERMINAL.includes(execution.status)} onClick={() => void guard(async () => {
                  await api.cancelExecution(execution.id); setExecutions(await api.workflowExecutions(selected.id));
                })}>Batalkan</button>
                <button type="button" disabled={busy} onClick={() => void guard(async () => {
                  const retried = await api.retryExecution(execution.id); setMessage(`Percobaan ke-${retried.attempt} dijalankan.`); await pollExecution(retried.id);
                })}>Ulangi</button>
                {execution.approvalStatus === 'pending' && (
                  <>
                    <button type="button" disabled={busy} onClick={() => void guard(async () => {
                      await api.decideApproval(execution.id, 'approved'); await pollExecution(execution.id);
                    })}>Setujui</button>
                    <button type="button" disabled={busy} onClick={() => void guard(async () => {
                      await api.decideApproval(execution.id, 'rejected'); setExecutions(await api.workflowExecutions(selected.id));
                    })}>Tolak</button>
                  </>
                )}
              </div>
            ))}
            {!executions.length && <small>Belum ada eksekusi.</small>}
          </div>

          {executionDetail && (
            <div className="execution-detail">
              <h4>Detail eksekusi {executionDetail.status}</h4>
              {executionDetail.error && <p className="error">{executionDetail.error}</p>}
              {(executionDetail.steps ?? []).map((step) => (
                <div key={step.id} className="step-result">
                  <b>#{step.stepIndex + 1} {step.type} <span className="badge">{step.status}</span></b>
                  {step.error && <p className="error">{step.error}</p>}
                  {step.output && <pre>{step.output.slice(0, 600)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const teamTab = (
    <div className="tool-body">
      <div className="tool-row wrap">
        <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="email anggota baru" />
        <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
          {['owner', 'admin', 'member', 'viewer'].map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
        <button type="button" className="primary" disabled={busy || !inviteEmail.trim()} onClick={() => void guard(async () => {
          const invitation = await api.invite(workspaceId!, inviteEmail.trim(), inviteRole);
          setInviteEmail(''); await loadTeam();
          setInviteLink(`${location.origin}/?invitation=${invitation.token}`);
          setMessage('Undangan dibuat. Kirim tautan di bawah ke anggota.');
        })}>Undang</button>
      </div>
      {inviteLink && <div className="tool-row"><input readOnly value={inviteLink} /><button type="button" onClick={() => void navigator.clipboard?.writeText(inviteLink)}>Salin</button></div>}
      <div className="tool-list">
        {members.map((member) => (
          <div key={member.userId}>
            <b>{member.displayName}</b>
            <small>{member.email}</small>
            <select value={member.role} disabled={busy} onChange={(event) => void guard(async () => {
              await api.updateMemberRole(workspaceId!, member.userId, event.target.value); await loadTeam(); setMessage('Peran diperbarui.');
            })}>
              {['owner', 'admin', 'member', 'viewer'].map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              await api.removeMember(workspaceId!, member.userId); await loadTeam(); setMessage('Anggota dihapus.');
            })}>Keluarkan</button>
          </div>
        ))}
      </div>
      <div className="tool-list">
        {invitations.filter((invitation) => !invitation.acceptedAt).map((invitation) => (
          <div key={invitation.id}>
            <b>{invitation.email}</b>
            <small>{invitation.role} · kedaluwarsa {new Date(invitation.expiresAt).toLocaleDateString('id-ID')}</small>
            <button type="button" disabled={busy} onClick={() => void guard(async () => {
              await api.revokeInvitation(invitation.id); await loadTeam(); setMessage('Undangan dibatalkan.');
            })}>Batalkan</button>
          </div>
        ))}
        {!invitations.length && <small>Belum ada undangan aktif.</small>}
      </div>
    </div>
  );

  const artifactTab = (
    <div className="tool-body">
      <div className="tool-row wrap">
        <label className="file-picker">Unggah artifact
          <input type="file" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadArtifactFile(file); event.target.value = ''; }} />
        </label>
      </div>
      <div className="tool-list">
        {artifacts.map((artifact) => (
          <div key={artifact.id}>
            <b>{artifact.name}</b>
            <small>{artifact.mimeType} · {(artifact.sizeBytes / 1024).toFixed(1)} KB · {artifact.sha256.slice(0, 10)}…</small>
            <a className="download" href={`/api/v1/artifacts/${artifact.id}/download`} target="_blank" rel="noreferrer">Unduh</a>
          </div>
        ))}
        {!artifacts.length && <small>Belum ada artifact di project ini.</small>}
      </div>
    </div>
  );

  const auditTab = (
    <div className="tool-body">
      <div className="tool-list">
        {audit.map((event) => (
          <div key={event.id}><b>{event.action}</b><small>{new Date(event.createdAt).toLocaleString('id-ID')} · {JSON.stringify(event.metadata).slice(0, 120)}</small></div>
        ))}
        {!audit.length && <small>Belum ada aktivitas.</small>}
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop">
      <section className="auth-card settings-card tool-card">
        <button type="button" className="close" onClick={onClose}>×</button>
        <span className="eyebrow">PROJECT TOOLS</span>
        <div className="tool-tabs">
          <button type="button" className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>Knowledge</button>
          <button type="button" className={tab === 'workflow' ? 'active' : ''} onClick={() => setTab('workflow')}>Workflow</button>
          <button type="button" className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>Tim</button>
          <button type="button" className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>Artifact</button>
          <button type="button" className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>Audit</button>
        </div>
        <h2>{tab === 'knowledge' ? 'Knowledge Base' : tab === 'workflow' ? 'Workflow Builder' : tab === 'team' ? 'Tim Workspace' : tab === 'artifacts' ? 'Artifact Project' : 'Audit Workspace'}</h2>
        {message && <p className="notice" onClick={() => setMessage('')}>{message}</p>}
        {tab === 'knowledge' ? knowledgeTab : tab === 'workflow' ? workflowTab : tab === 'team' ? teamTab : tab === 'artifacts' ? artifactTab : auditTab}
      </section>
    </div>
  );
}

function move(steps: WorkflowStep[], from: number, to: number) {
  const copy = [...steps];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function patchSteps(steps: WorkflowStep[], index: number, patch: Partial<WorkflowStep>) {
  return steps.map((step, position) => position === index ? { ...step, ...patch } : step);
}

function patchCaseSteps(steps: WorkflowStep[], index: number, caseIndex: number, patch: { field?: string; value?: string; goto?: string }) {
  return steps.map((step, position) => {
    if (position !== index) return step;
    const cases = [...(step.cases ?? [])];
    cases[caseIndex] = { ...cases[caseIndex], ...patch };
    return { ...step, cases };
  });
}

/** Reads a File as Base64 without the data URL prefix. */
function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const result = String(reader.result ?? ''); resolve(result.includes(',') ? result.split(',')[1] : result); };
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}
