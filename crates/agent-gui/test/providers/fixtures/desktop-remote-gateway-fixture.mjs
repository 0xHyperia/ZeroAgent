import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketFrame(payload, opcode = 2) {
  const body = Buffer.from(payload);
  const prefix = body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(prefix);
  header[0] = 0x80 | opcode;
  if (prefix === 2) header[1] = body.length;
  else if (prefix === 4) {
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

// A loopback-only WebSocket peer. It implements the framing needed by Node's real
// browser-compatible WebSocket, while all application messages use production
// generated Protobuf schemas. No fake client or external model is involved.
function receiveFrames(socket, onBinary) {
  let pending = Buffer.alloc(0);
  let fragments = [];
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const final = (pending[0] & 0x80) !== 0;
      const opcode = pending[0] & 15;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      assert.ok(masked, "browser WebSocket frames are masked");
      assert.ok(length <= 2 ** 20, "fixture does not accept unbounded messages");
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      pending = pending.subarray(offset + length);
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      if (opcode === 8) {
        socket.end(websocketFrame(payload, 8));
        return;
      }
      if (opcode === 9) {
        socket.write(websocketFrame(payload, 10));
        continue;
      }
      if (opcode === 10) continue;
      assert.ok(opcode === 2 || opcode === 0, "Gateway application frames are binary");
      fragments.push(payload);
      if (final) {
        const message = Buffer.concat(fragments);
        fragments = [];
        onBinary(message);
      }
    }
  });
}

export async function createDesktopRemoteGatewayFixture(codec, options = {}) {
  const frames = [];
  const peers = new Set();
  const settings = new Map();
  const executedRuns = new Map();
  const deniedLeases = new Set();
  let nextDrop = null;
  let sequence = 0;
  const errors = [];
  for (const agent of ["device-a", "device-b"]) {
    settings.set(agent, {
      configurationVersion: `version-${agent}-1`,
      customProviders: [{
        id: `relay-${agent}`, type: "codex", enabled: true,
        promptCacheHintMode: "auto",
        models: [{ id: `model-${agent}`, contextWindow: 32000, maxOutputTokens: 512 }],
        enabledModels: [`model-${agent}`],
      }],
    });
  }
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      assert.equal(request.url, "/ws/v2");
      assert.equal(request.headers["sec-websocket-protocol"], "liveagent.v2.pb");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(head.length, 0);
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + WEBSOCKET_GUID)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`, "Sec-WebSocket-Protocol: liveagent.v2.pb", "", "",
      ].join("\r\n"));
      const peer = { socket, agent: "", send: (value) => socket.write(websocketFrame(codec.encodeServerFrame(value))) };
      peers.add(peer);
      socket.on("close", () => peers.delete(peer));
      socket.on("error", () => {});
      receiveFrames(socket, (raw) => {
        try {
          const decoded = codec.decodeClientFrame(raw);
          const value = decoded.json;
          frames.push({ ...decoded, peer });
          const reply = (payload) => peer.send({ request_id: decoded.requestId, ...payload });
          if (decoded.case === "hello") {
            const lease = value.hello.selection_lease;
            peer.agent = lease === "lease-device-a" ? "device-a" : lease === "lease-device-b" ? "device-b" : "";
            assert.equal(value.hello.token, "opaque-native-session", "only a synthetic opaque Native handle reaches this peer");
            if (!peer.agent || deniedLeases.has(lease)) {
              reply({ hello: { ok: false, message: "selection lease expired" } });
              return;
            }
            reply({ hello: { ok: true } });
            return;
          }
          assert.ok(peer.agent, "a Native-owned selection hello precedes every command");
          if (options.onRequest?.(decoded, reply, peer) === true) return;
          if (decoded.case === "agentList") {
            reply({ agent_list: { agents: [{ agent_id: peer.agent, online: true }] } });
            return;
          }
          if (decoded.case === "pong") return;
          assert.equal(value.agent_id, peer.agent, "commands stay bound to the selected device");
          if (decoded.case === "statusGet" || decoded.case === "chatPrepare") {
            reply({ status: { agent_id: peer.agent, online: true, agent_ready: true, chat_runtime_ready: true } });
            return;
          }
          if (decoded.case === "chatCommand") {
            const command = value.chat_command.request;
            const runKey = `${peer.agent}:${command.client_request_id}`;
            const known = executedRuns.get(runKey);
            if (!known) executedRuns.set(runKey, `run-${++sequence}`);
            if (nextDrop === "chat_command") {
              nextDrop = null;
              socket.destroy();
              return;
            }
            reply({ chat_accepted: { run_id: executedRuns.get(runKey), conversation_id: command.conversation_id, accepted_seq: 1, deduped: Boolean(known) } });
            return;
          }
          if (decoded.case === "chatSubscribe") {
            reply({ chat_subscribed: { conversation_id: value.chat_subscribe.conversation_id, stream_epoch: `epoch-${peer.agent}`, latest_seq: 0, reset: true } });
            return;
          }
          if (decoded.case === "chatUnsubscribe") {
            reply({ ack: { ok: true } });
            return;
          }
          const envelope = value.agent_request;
          assert.ok(envelope, `unexpected request ${decoded.case}`);
          if (envelope.settings_get) {
            reply({ agent_response: { settings_get_resp: { settings_json: JSON.stringify(settings.get(peer.agent)) } } });
            return;
          }
          if (envelope.settings_update) {
            const update = JSON.parse(envelope.settings_update.settings_json);
            const before = settings.get(peer.agent);
            if (update.configurationVersion !== before.configurationVersion) {
              reply({ agent_response: { settings_update_resp: { accepted: false, message: "configuration_changed" } } });
              return;
            }
            settings.set(peer.agent, { ...before, ...update, configurationVersion: `version-${peer.agent}-${++sequence + 1}` });
            if (nextDrop === "settings_update") {
              nextDrop = null;
              socket.destroy();
              return;
            }
            reply({ agent_response: { settings_update_resp: { accepted: true } } });
            return;
          }
          if (envelope.chat_queue?.action === "tool_approval") {
            if (nextDrop === "tool_approval") {
              nextDrop = null;
              socket.destroy();
              return;
            }
            reply({ agent_response: { chat_queue_resp: { accepted: true, revision: 1 } } });
            return;
          }
          throw Error(`Unhandled Gateway envelope: ${Object.keys(envelope).join(",")}`);
        } catch (error) {
          errors.push(error);
          socket.destroy();
        }
      });
    } catch (error) {
      errors.push(error);
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    frames, settings, executedRuns,
    get peerCount() { return peers.size; },
    dropAfterMutation(kind) { nextDrop = kind; },
    expireLease(lease) { deniedLeases.add(lease); },
    disconnectAgent(agent) { for (const peer of peers) if (peer.agent === agent) peer.socket.destroy(); },
    assertHealthy() { assert.deepEqual(errors, [], errors.map(String).join("\n")); },
    async close() {
      for (const peer of peers) peer.socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
