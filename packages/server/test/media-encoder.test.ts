import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AmeWebService, buildManifest, candidateHosts, isTerminalStatus, parseHistory, parseJob, parseServer, tag } from "../src/drivers/ame-webservice.js";
import { JobRegistry } from "../src/jobs.js";
import { registerMediaEncoderTools } from "../src/tools/media-encoder.js";

const payload = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE payload><payload version="1.0">\n${inner}\n</payload>`;

describe("AME web service XML", () => {
  it("parses server, job and history payloads", () => {
    const s = parseServer(payload("<ServerIP>192.168.1.51</ServerIP><ServerPort>8080</ServerPort><ServerStatus>Online</ServerStatus><JobStatus>Not Found</JobStatus><JobId></JobId><JobProgress></JobProgress><Details></Details>"));
    expect(s).toMatchObject({ serverStatus: "Online", jobStatus: "Not Found", serverIp: "192.168.1.51" });
    const j = parseJob(payload("<JobStatus>Success</JobStatus><JobId>abc</JobId><Details>Completed encoding source: C:\\a &amp; b.wav</Details><DestinationPath>C:\\out.mp3</DestinationPath>"));
    expect(j).toMatchObject({ jobId: "abc", jobStatus: "Success", details: "Completed encoding source: C:\\a & b.wav", destinationPath: "C:\\out.mp3" });
    const h = parseHistory(payload("<JobStatus>Success</JobStatus><CompletedJobs><Job><JobId>1</JobId><JobStatus>Success</JobStatus></Job><Job><JobId>2</JobId><JobStatus>Failed</JobStatus><Details>bad</Details></Job></CompletedJobs>"));
    expect(h.map((x) => x.jobId)).toEqual(["1", "2"]);
    expect(tag("<a><b>x</b></a>", "c")).toBe("");
    expect(isTerminalStatus("Encoding")).toBe(false);
    expect(isTerminalStatus("Success")).toBe(true);
  });

  it("builds a manifest with escaping and optional fields", () => {
    const m = buildManifest({ sourcePath: "C:\\in & out.wav", presetPath: "C:\\p.epr", destinationPath: "C:\\o.mp3", overwrite: true, sequenceGuid: "g-1" });
    expect(m).toContain("<SourceFilePath>C:\\in &amp; out.wav</SourceFilePath>");
    expect(m).toContain("<OverwriteDestinationIfPresent>true</OverwriteDestinationIfPresent>");
    expect(m).toContain("<SequenceGUID>g-1</SequenceGUID>");
    expect(buildManifest({ sourcePath: "a", presetPath: "b", destinationPath: "c" })).not.toContain("SequenceGUID");
  });

  it("probes loopback first", () => {
    expect(candidateHosts()[0]).toBe("127.0.0.1");
  });
});

/** A fake Remote AME: one job at a time, Queued → Encoding → Success over three polls. */
function fakeAme() {
  let job: { id: string; status: string; polls: number; dest: string; preset: string; src: string } | null = null;
  const history: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (inner: string) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(payload(inner));
    };
    const jobXml = () => (job ? `<ServerStatus>Online</ServerStatus><JobStatus>${job.status}</JobStatus><JobId>${job.id}</JobId><JobProgress>${job.status === "Encoding" ? 50 : ""}</JobProgress><Details>d</Details><SourcePresetPath>${job.preset}</SourcePresetPath><SourceFilePath>${job.src}</SourceFilePath><DestinationPath>${job.dest}</DestinationPath>` : "<ServerStatus>Online</ServerStatus><JobStatus>Not Found</JobStatus><JobId></JobId><JobProgress></JobProgress><Details></Details>");
    if (req.method === "GET" && url === "/server") return send("<ServerIP>127.0.0.1</ServerIP><ServerPort>0</ServerPort><ServerStatus>Online</ServerStatus><JobStatus>Not Found</JobStatus><JobId></JobId>");
    if (req.method === "GET" && url === "/job") {
      if (job && !/Success|Abort/.test(job.status)) {
        job.polls++;
        job.status = job.polls >= 3 ? "Success" : "Encoding";
        if (job.status === "Success") history.push(`<Job><JobId>${job.id}</JobId><JobStatus>Success</JobStatus></Job>`);
      }
      return send(jobXml());
    }
    if (req.method === "GET" && url === "/history") return send(`${jobXml()}<CompletedJobs>${history.join("")}</CompletedJobs>`);
    if (req.method === "POST" && url === "/job") {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        job = { id: `job-${history.length + 1}`, status: "Queued", polls: 0, dest: tag(body, "DestinationPath"), preset: tag(body, "SourcePresetPath"), src: tag(body, "SourceFilePath") };
        send(`<SubmitResult>Accepted</SubmitResult>${jobXml()}`);
      });
      return;
    }
    if (req.method === "DELETE" && url.startsWith("/job")) {
      if (job) job.status = "Aborted";
      return send(jobXml());
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

describe("Media Encoder tools against a fake Remote AME", () => {
  let http: Server;
  let baseUrl: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    http = fakeAme();
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const addr = http.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const ame = new AmeWebService({ exePath: "", port: 0, extraArgs: [], idleMs: 0, baseUrl });
    const jobs = new JobRegistry({ workRoot: join(tmpdir(), `acm-ame-${process.pid}`) });
    const server = new McpServer({ name: "t", version: "0" });
    registerMediaEncoderTools(server, ame, { jobs });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    close = async () => {
      await client.close();
      await server.close();
      await new Promise<void>((r) => http.close(() => r()));
    };
  });

  afterAll(async () => {
    await close();
  });

  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;

  it("reports the service and runs an encode job to Success with progress", async () => {
    const s = text(await client.callTool({ name: "ame_server", arguments: {} }));
    expect(s["running"]).toBe(true);
    const r = await client.callTool({ name: "ame_encode", arguments: { source: "C:/in.wav", output: join(tmpdir(), "acm-ame-out.mp3"), presetPath: "C:/p.epr" } });
    expect(r.isError).not.toBe(true);
    const view = text(r) as { status: string; steps: { status: string }[]; result: { ameJobId: string; final: { jobStatus: string } } };
    expect(view.status).toBe("succeeded");
    expect(view.steps.map((x) => x.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(view.result.ameJobId).toBe("job-1");
    expect(view.result.final.jobStatus).toBe("Success");
    const h = text(await client.callTool({ name: "ame_history", arguments: {} })) as unknown as { jobId: string }[];
    expect(h[0]?.jobId).toBe("job-1");
  });

  it("requires a preset", async () => {
    const r = await client.callTool({ name: "ame_encode", arguments: { source: "C:/in.wav", output: "C:/o.mp3", presetName: "definitely-not-a-preset-name-xyz" } });
    expect(r.isError).toBe(true);
  });
});
