const express=require("express"),path=require("path"),app=express();
const {createProxyMiddleware}=require("http-proxy-middleware");
const fs=require("fs");
const TG_TOKEN_PATH="/app/data/tg_token";
const TG_CHAT_ID="-1004274217110";

// --- Hardening ---
app.disable("x-powered-by");

// CORS: allowlist only (fix MEDIUM #1) - hanya origin Papi
const ALLOWED_ORIGINS=["https://chat.coblai.com","https://www.coblai.com","https://coblai.com"];
app.use(require("cors")({
  origin:function(origin,cb){
    if(!origin) return cb(null,true);
    if(ALLOWED_ORIGINS.includes(origin)) return cb(null,true);
    return cb(null,false);
  },
  credentials:true,
  methods:["GET","HEAD","POST","PUT","PATCH","DELETE"],
  allowedHeaders:["Content-Type","Authorization","X-Requested-With"]
}));

// Security headers (fix LOW #4 - CSP global, plus nosniff etc - applied to every response)
const CSP="default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'self'";
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",CSP);
  res.setHeader("X-XSS-Protection","1; mode=block");
  // remove Via if present
  res.removeHeader("Via");
  next();
});

// Block sensitive paths before static (fix LOW #5 - SPA fallback)
const BLOCKED_RE=new RegExp("^(\\/\\.env|\\/\\.git(\\/|$)|\\/\\.DS_Store|\\/backup\\.zip)(\\/|$)");
app.use((req,res,next)=>{
  if(BLOCKED_RE.test(req.path)) return res.status(404).send("Not found");
  next();
});

app.use(express.json({limit:"50mb"}));
app.use(express.urlencoded({limit:"50mb",extended:true}));

async function tgSend(text){
  try{
    const token=fs.readFileSync(TG_TOKEN_PATH,"utf8").trim();
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TG_CHAT_ID,text,parse_mode:"Markdown"})});
  }catch(e){console.log("tg fail",e.message)}
}

app.use("/api", createProxyMiddleware({
  target:"http://prime-agent-hub:3000",
  changeOrigin:true,
  ws:true,
  selfHandleResponse:false,
  onProxyReq:(proxyReq,req)=>{
    // Fix 3 Sep 2026: express.json() sudah mengonsumsi stream body → untuk SEMUA
    // POST/PUT/PATCH yang punya body (termasuk body kosong "{}") tulis ulang dari
    // req.body. Sebelumnya body dengan key kosong tidak ditulis → hub menunggu body
    // selamanya (webhook hang).
    if((req.method==="POST"||req.method==="PUT"||req.method==="PATCH") && req.body !== undefined){
      const b=JSON.stringify(req.body);
      proxyReq.setHeader("Content-Length",Buffer.byteLength(b));
      proxyReq.write(b);
      if(req.url.includes("/chat")||req.url.includes("/message")){
        const m=req.body.message||req.body.prompt||req.body.text||b.slice(0,150);
        if(m) tgSend(`\uD83D\uDC68 *User via chat.coblai.com*\n${String(m).slice(0,700)}`);
      }
    }
  }
}));

app.get("/api/events", (req,res,next)=>{
  const http=require("http");
  const opts={hostname:"prime-agent-hub",port:3000,path:"/api/events?"+(req.url.split("?")[1]||""),method:"GET",headers:{...req.headers,host:"prime-agent-hub:3000"}};
  if(req.headers.cookie) opts.headers.cookie=req.headers.cookie;
  const pr=http.request(opts, prRes=>{
    res.writeHead(prRes.statusCode, prRes.headers);
    prRes.on("data", chunk=>{
      res.write(chunk);
      const txt=chunk.toString();
      txt.split("\n").forEach(line=>{
        if(line.startsWith("data:")){
          try{
            const j=JSON.parse(line.slice(5).trim());
            if(j.type==="tool_start") tgSend(`\uD83D\uDD27 *Tool:* \`${j.tool}\` \u2014 mulai`);
            else if(j.type==="tool_end") tgSend(`\u2705 *Tool:* \`${j.tool}\` \u2014 selesai`);
            else if(j.type==="agent_end") tgSend(`\u2705 *Dinda selesai* \u2014 cek https://chat.coblai.com`);
          }catch(e){}
        }
      });
    });
    prRes.on("end",()=>res.end());
  });
  pr.on("error",e=>{console.log("SSE err",e.message); next(e)});
  pr.end();
  req.on("close",()=>pr.destroy());
});

app.use(express.static(path.join(__dirname,"frontend")));
// Fix MEDIUM #3 + LOW #5: health without tg leak, and SPA fallback after block
app.get("/health",(req,res)=>res.json({ok:true,service:"coblai-chat"}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"frontend","index.html")));
app.listen(3102,"0.0.0.0",()=>{console.log("COBLAI chat on 3102 hardened");});
