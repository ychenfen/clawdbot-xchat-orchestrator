#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { GatewayClient } from 'clawdbot/dist/gateway/client.js';

const HOME = process.env.HOME || os.homedir();

const OPENCLAW_DIR = process.env.OPENCLAW_DIR
  ? path.resolve(process.env.OPENCLAW_DIR)
  : path.join(HOME, '.openclaw');
const DEEPSEEK_DIR = process.env.DEEPSEEK_DIR
  ? path.resolve(process.env.DEEPSEEK_DIR)
  : path.join(HOME, '.clawd-deepseek');
const GLM_DIR = process.env.GLM_DIR ? path.resolve(process.env.GLM_DIR) : path.join(HOME, '.clawd-glm');

const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';

const STATE_PATH = process.env.XCHAT_STATE_PATH
  ? path.resolve(process.env.XCHAT_STATE_PATH)
  : path.join(OPENCLAW_DIR, 'xchat', 'state.json');
const SESSION_STORE_PATH = process.env.OPENCLAW_SESSION_STORE_PATH
  ? path.resolve(process.env.OPENCLAW_SESSION_STORE_PATH)
  : path.join(OPENCLAW_DIR, 'agents', OPENCLAW_AGENT_ID, 'sessions', 'sessions.json');

const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  ? path.resolve(process.env.OPENCLAW_CONFIG_PATH)
  : path.join(OPENCLAW_DIR, 'openclaw.json');
const DEEPSEEK_CONFIG_PATH = process.env.DEEPSEEK_CONFIG_PATH
  ? path.resolve(process.env.DEEPSEEK_CONFIG_PATH)
  : path.join(DEEPSEEK_DIR, 'clawdbot.json');
const GLM_CONFIG_PATH = process.env.GLM_CONFIG_PATH
  ? path.resolve(process.env.GLM_CONFIG_PATH)
  : path.join(GLM_DIR, 'clawdbot.json');

const DEFAULTS = {
  cooldownMs: 8_000,
  maxTriggersPerMinute: 6,
  maxCharsPerPrompt: 6_000,
  rounds: 1,
};

function log(msg, extra = undefined) {
  const line = `[xchat] ${new Date().toISOString()} ${msg}`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(line, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function safeReadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid state root');
    parsed.chats ??= {};
    return parsed;
  } catch {
    return { chats: {} };
  }
}

function saveState(state) {
  ensureDir(path.dirname(STATE_PATH));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function normalizeText(value) {
  return typeof value === 'string' ? value : '';
}

function extractTextFromMessageContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && c.type === 'text' ? normalizeText(c.text) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractUserText(raw) {
  const s = normalizeText(raw).trim();
  if (!s) return '';

  // OpenClaw sometimes prefixes group metadata blocks.
  // We strip the trailing content after the last fenced code block.
  if (s.includes('Conversation info (untrusted metadata):') && s.includes('Sender (untrusted metadata):')) {
    const lastFence = s.lastIndexOf('```');
    if (lastFence !== -1) {
      const after = s.slice(lastFence + 3).trim();
      if (after) return after;
    }
  }

  return s;
}

function isControlCommand(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('/')) return true;
  return false;
}

function matchModeCommand(text) {
  const t = text.trim();
  if (!t) return null;

  const on = ['开启交流模式', '打开交流模式', '交流模式开', '/xchat on', '/xchat 开', '/xchat 开启'];
  const onTrio = [
    '开启三方交流模式',
    '开启三人交流模式',
    '开启三方互聊',
    '三方互聊开',
    '/xchat trio',
    '/xchat 三方',
    '/xchat 3',
  ];
  const off = ['关闭交流模式', '退出交流模式', '交流模式关', '/xchat off', '/xchat 关', '/xchat 关闭'];
  const status = ['交流模式状态', '/xchat status', '/xchat 状态'];
  const kickoff = ['开场互聊', '交流开场', '/xchat kickoff', '/xchat 开场'];
  const kickoffTrio = ['开场三方互聊', '三方交流开场', '/xchat kickoff3', '/xchat 三方开场'];

  if (onTrio.includes(t)) return { kind: 'on', mode: 'trio' };
  if (on.includes(t)) return { kind: 'on', mode: 'duo' };
  if (off.includes(t)) return { kind: 'off' };
  if (status.includes(t)) return { kind: 'status' };
  if (kickoffTrio.includes(t)) return { kind: 'kickoff', mode: 'trio' };
  if (kickoff.includes(t)) return { kind: 'kickoff' };

  // Allow a simple "交流轮数 2".
  const m = t.match(/^交流轮数\s+(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 3) return { kind: 'rounds', rounds: n };
  }

  return null;
}

function clampPrompt(s) {
  const t = normalizeText(s);
  if (t.length <= DEFAULTS.maxCharsPerPrompt) return t;
  return t.slice(0, DEFAULTS.maxCharsPerPrompt) + `\n\n(已截断，原长 ${t.length} chars)`;
}

function loadGatewayUrl(configPath, fallbackPort) {
  const cfg = safeReadJson(configPath);
  const port = cfg?.gateway?.port ?? fallbackPort;
  return `ws://127.0.0.1:${port}`;
}

function loadGatewayToken(configPath) {
  const cfg = safeReadJson(configPath);
  const mode = cfg?.gateway?.auth?.mode;
  const token = cfg?.gateway?.auth?.token;

  if (mode === 'token') {
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`gateway auth token missing in ${configPath}`);
    }
    return token.trim();
  }

  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

async function waitReady(client, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await client.request('status', {}, { expectFinal: true });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`${label} gateway not ready after 10s`);
}

async function sendTelegram(client, to, message) {
  await client.request(
    'send',
    {
      to,
      message,
      channel: 'telegram',
      idempotencyKey: randomUUID(),
    },
    { expectFinal: true },
  );
}

async function patchSession(client, label, patch) {
  const key = typeof patch?.key === 'string' ? patch.key : '';
  const payload = await client.request('sessions.patch', patch, { expectFinal: true });
  log(`sessions.patch ok label=${label} key=${payload?.key ?? key}`);
  return payload;
}


async function runAgent(client, label, { sessionKey, replyTo, message, extraSystemPrompt }) {
  const payload = await client.request(
    'agent',
    {
      message: clampPrompt(message),
      sessionKey,
      deliver: true,
      replyChannel: 'telegram',
      replyTo,
      extraSystemPrompt,
      idempotencyKey: randomUUID(),
    },
    { expectFinal: true },
  );

  if (!payload || payload.status !== 'ok') {
    throw new Error(`${label} agent failed: ${JSON.stringify(payload)}`);
  }

  const payloads = payload?.result?.payloads ?? [];
  const text = Array.isArray(payloads)
    ? payloads
        .map((p) => (p && typeof p === 'object' ? normalizeText(p.text) : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
    : '';

  return { text, meta: payload?.result?.meta };
}

function listTelegramGroupSessions() {
  const store = safeReadJson(SESSION_STORE_PATH);
  const entries = Object.entries(store);
  const groups = [];

  for (const [key, value] of entries) {
    if (!key.includes(':telegram:group:')) continue;
    const sessionFile = value?.sessionFile;
    if (!sessionFile || typeof sessionFile !== 'string') continue;
    const chatId = key.split(':').at(-1);
    if (!chatId) continue;
    groups.push({ chatId, sessionKey: key, sessionFile });
  }

  return groups;
}

class JsonlTailer {
  constructor({ file, onLine }) {
    this.file = file;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
  }

  start({ fromEnd = true } = {}) {
    const st = fs.statSync(this.file);
    this.offset = fromEnd ? st.size : 0;

    this.watcher = fs.watch(this.file, { persistent: true }, (evt) => {
      if (evt !== 'change') return;
      void this._readAppend();
    });

    log(`tailing ${this.file} (fromEnd=${fromEnd})`);
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
  }

  async _readAppend() {
    const st = fs.statSync(this.file);
    if (st.size < this.offset) {
      // file truncated
      this.offset = 0;
      this.buffer = '';
    }
    if (st.size === this.offset) return;

    const len = st.size - this.offset;
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      this.buffer += buf.toString('utf8');

      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          await this.onLine(trimmed);
        } catch (err) {
          log(`line handler error: ${String(err)}`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

async function main() {
  ensureDir(path.join(OPENCLAW_DIR, 'xchat'));

  const openclawUrl = loadGatewayUrl(OPENCLAW_CONFIG_PATH, 18789);
  const deepseekUrl = loadGatewayUrl(DEEPSEEK_CONFIG_PATH, 18790);
  const glmUrl = loadGatewayUrl(GLM_CONFIG_PATH, 18791);

  const openclawToken = loadGatewayToken(OPENCLAW_CONFIG_PATH);

  const openclaw = new GatewayClient({ url: openclawUrl, token: openclawToken });
  const deepseek = new GatewayClient({ url: deepseekUrl });
  const glm = new GatewayClient({ url: glmUrl });

  openclaw.start();
  deepseek.start();
  glm.start();

  await Promise.all([
    waitReady(openclaw, 'openclaw'),
    waitReady(deepseek, 'deepseek'),
    waitReady(glm, 'glm'),
  ]);

  log(`connected gateways: openclaw=${openclawUrl} deepseek=${deepseekUrl} glm=${glmUrl}`);

  const sessions = listTelegramGroupSessions();
  if (sessions.length === 0) {
    throw new Error('no telegram group sessions found in openclaw session store');
  }

  log(`found telegram group sessions: ${sessions.map((s) => s.chatId).join(', ')}`);

  const state = loadState();
  const inFlight = new Map(); // chatId -> boolean
  const recent = new Map(); // chatId -> number[] timestamps

  const replyToFor = (chatId) => `telegram:group:${chatId}`;

  const ensureChatState = (chatId) => {
    state.chats[chatId] ??= {
      enabled: false,
      mode: 'duo',
      rounds: DEFAULTS.rounds,
      cooldownMs: DEFAULTS.cooldownMs,
      lastTriggerAt: 0,
      bridge: { lastDeepseek: '', lastGlm: '', lastOpenclaw: '' },
    };
    state.chats[chatId].mode ??= 'duo';
    state.chats[chatId].bridge ??= { lastDeepseek: '', lastGlm: '', lastOpenclaw: '' };
    state.chats[chatId].bridge.lastOpenclaw ??= '';
    return state.chats[chatId];
  };

  const BOT_NAMES = {
    openclaw: '@yuchenxu_clawdbot',
    deepseek: '@yuchenxu_deepseek_bot',
    glm: '@yuchenxu_glm_bot',
  };

  const KICKOFF_DUO_USER_TEXT = [
    '交流模式开场：你们两位先互相认识（各用一句话：模型/定位/擅长）。',
    '然后选一个协作主题开始讨论，最后给用户一个可执行的下一步。',
  ].join('\n');

  const KICKOFF_TRIO_USER_TEXT = [
    '三方交流开场：DeepSeek、GLM、Jarvis 依次自我介绍（各一句：模型/定位/擅长）。',
    '然后选一个协作主题，按“DeepSeek -> GLM -> Jarvis”接力推进，最后给用户一个可执行的下一步。',
  ].join('\n');

  const driveTurnsDuo = async ({ chatId, sessionKey, userText, roundsOverride }) => {
    const chatState = ensureChatState(chatId);
    chatState.bridge ??= { lastDeepseek: '', lastGlm: '', lastOpenclaw: '' };

    const rounds = Math.min(3, Math.max(1, Number(roundsOverride ?? chatState.rounds ?? 1)));
    const to = replyToFor(chatId);

    // Seed with the previous GLM output so DeepSeek can respond across turns.
    let last = normalizeText(chatState.bridge.lastGlm);

    for (let round = 1; round <= rounds; round++) {
      const dsPrompt = [
        `你是 DeepSeek bot，在“交流模式”下与 GLM 协作。`,
        `你会通过编排器看到对方的回复，所以可以直接引用/回应；不要讨论 Telegram/Bot API 的限制。`,
        `请直接对 ${BOT_NAMES.glm} 说话，第一行必须以“${BOT_NAMES.glm}”开头。`,
        `用户说: ${userText}`,
        last ? `上一轮 GLM 回复(供参考，可能与当前话题无关，必要时忽略): ${last}` : '',
        `如果上一轮里出现“问DeepSeek:”且与当前话题相关，请先用1-2句回答。`,
        `请输出:`,
        `- 你的观点/方案（3-6条要点）`,
        `- 对上一轮的补充/修正（如果有）`,
        `- 你要问 GLM 的一个具体问题（最后一行以“问GLM:”开头）`,
        `要求: 中文，<= 220 字。`,
      ]
        .filter(Boolean)
        .join('\n');

      const ds = await runAgent(deepseek, 'deepseek', {
        sessionKey,
        replyTo: to,
        message: dsPrompt,
      });

      chatState.bridge.lastDeepseek = normalizeText(ds.text);

      const glmPrompt = [
        `你是 GLM bot，在“交流模式”下接力 DeepSeek。`,
        `你会通过编排器看到对方的回复，所以可以直接引用/回应；不要讨论 Telegram/Bot API 的限制。`,
        `请直接对 ${BOT_NAMES.deepseek} 说话，第一行必须以“${BOT_NAMES.deepseek}”开头。`,
        `用户说: ${userText}`,
        `DeepSeek 回复: ${ds.text || '(空)'}`,
        `如果 DeepSeek 里出现“问GLM:”请先用1-2句回答。`,
        `请输出:`,
        `- 你的收敛/执行建议（3-5条）`,
        `- 回答 DeepSeek 的问题（若有）`,
        `- 你要问 DeepSeek 的一个具体问题（倒数第二行以“问DeepSeek:”开头）`,
        `- 给用户的 1 个澄清问题（最后一行以“问用户:”开头）`,
        `要求: 中文，<= 260 字。`,
      ].join('\n');

      const g = await runAgent(glm, 'glm', {
        sessionKey,
        replyTo: to,
        message: glmPrompt,
      });

      chatState.bridge.lastGlm = normalizeText(g.text);
      last = chatState.bridge.lastGlm;
      saveState(state);
    }

    saveState(state);
  };

  const driveTurnsTrio = async ({ chatId, sessionKey, userText, roundsOverride }) => {
    const chatState = ensureChatState(chatId);
    chatState.bridge ??= { lastDeepseek: '', lastGlm: '', lastOpenclaw: '' };

    const rounds = Math.min(3, Math.max(1, Number(roundsOverride ?? chatState.rounds ?? 1)));
    const to = replyToFor(chatId);

    // Seed with the last OpenClaw output (or GLM as fallback) so the next DeepSeek turn has continuity.
    let last = normalizeText(chatState.bridge.lastOpenclaw) || normalizeText(chatState.bridge.lastGlm);

    for (let round = 1; round <= rounds; round++) {
      const dsPrompt = [
        `你是 DeepSeek bot，在“三方交流模式”下与 GLM、Jarvis 协作。`,
        `你会通过编排器看到对方的回复，所以可以直接引用/回应；不要讨论 Telegram/Bot API 的限制。`,
        `请直接对 ${BOT_NAMES.glm} 说话，第一行必须以“${BOT_NAMES.glm}”开头。`,
        `用户说: ${userText}`,
        last ? `上一轮 Jarvis/GLM 回复(供参考，必要时忽略): ${last}` : '',
        `请输出:`,
        `- 你的观点/方案（2-5条）`,
        `- 你要问 GLM 的一个具体问题（最后一行以“问GLM:”开头）`,
        `要求: 中文，<= 220 字。`,
      ]
        .filter(Boolean)
        .join('\n');

      const ds = await runAgent(deepseek, 'deepseek', {
        sessionKey,
        replyTo: to,
        message: dsPrompt,
      });
      chatState.bridge.lastDeepseek = normalizeText(ds.text);

      const glmPrompt = [
        `你是 GLM bot，在“三方交流模式”下接力 DeepSeek。`,
        `你会通过编排器看到对方的回复，所以可以直接引用/回应；不要讨论 Telegram/Bot API 的限制。`,
        `请直接对 ${BOT_NAMES.openclaw} 说话，第一行必须以“${BOT_NAMES.openclaw}”开头。`,
        `用户说: ${userText}`,
        `DeepSeek 回复: ${ds.text || '(空)'}`,
        `如果 DeepSeek 里出现“问GLM:”请先用1-2句回答。`,
        `请输出:`,
        `- 你的收敛/执行建议（2-5条）`,
        `- 你要问 Jarvis 的一个具体问题（最后一行以“问Jarvis:”开头）`,
        `要求: 中文，<= 260 字。`,
      ].join('\n');

      const g = await runAgent(glm, 'glm', {
        sessionKey,
        replyTo: to,
        message: glmPrompt,
      });
      chatState.bridge.lastGlm = normalizeText(g.text);

      const ocPrompt = [
        `你是 Jarvis（OpenClaw 主机器人），在“三方交流模式”下接力 GLM。`,
        `你会通过编排器看到 DeepSeek/GLM 的回复，所以可以直接引用/回应；不要讨论 Telegram/Bot API 的限制。`,
        `请直接对 ${BOT_NAMES.deepseek} 说话，第一行必须以“${BOT_NAMES.deepseek}”开头。`,
        `用户说: ${userText}`,
        `DeepSeek 回复: ${ds.text || '(空)'}`,
        `GLM 回复: ${g.text || '(空)'}`,
        `请输出:`,
        `- 你对两者的整合/取舍（2-4条）`,
        `- 给用户的 1 个澄清问题（最后一行以“问用户:”开头）`,
        `要求: 中文，<= 260 字。`,
      ].join('\n');

      const oc = await runAgent(openclaw, 'openclaw', {
        sessionKey,
        replyTo: to,
        message: ocPrompt,
      });
      chatState.bridge.lastOpenclaw = normalizeText(oc.text);
      last = chatState.bridge.lastOpenclaw || chatState.bridge.lastGlm;

      saveState(state);
    }

    saveState(state);
  };

  const driveTurns = async ({ chatId, sessionKey, userText, roundsOverride, modeOverride }) => {
    const chatState = ensureChatState(chatId);
    const mode = modeOverride ?? chatState.mode ?? 'duo';
    if (mode === 'trio') {
      return driveTurnsTrio({ chatId, sessionKey, userText, roundsOverride });
    }
    return driveTurnsDuo({ chatId, sessionKey, userText, roundsOverride });
  };

  const tailers = [];

  for (const sess of sessions) {
    const chatId = sess.chatId;
    const chatState = ensureChatState(chatId);
    saveState(state);

    const tailer = new JsonlTailer({
      file: sess.sessionFile,
      onLine: async (line) => {
        const obj = JSON.parse(line);
        if (obj?.type !== 'message') return;
        const msg = obj?.message;
        if (!msg) return;
        if (msg.role !== 'user') return;

        const raw = extractTextFromMessageContent(msg.content);
        const text = extractUserText(raw);
        if (!text) return;

        const cmd = matchModeCommand(text);
        if (cmd) {
          if (cmd.kind === 'on') {
            const desiredMode = cmd.mode === 'trio' ? 'trio' : 'duo';
            try {
              // Prevent double replies: orchestrator will drive DeepSeek/GLM turns.
              await Promise.all([
                patchSession(deepseek, 'deepseek', {
                  key: sess.sessionKey,
                  groupActivation: 'mention',
                }),
                patchSession(glm, 'glm', {
                  key: sess.sessionKey,
                  groupActivation: 'mention',
                }),
              ]);
            } catch (err) {
              log(`failed to enable xchat (session patch): ${String(err)}`);
              await sendTelegram(openclaw, replyToFor(chatId), `交流模式开启失败: ${String(err)}`);
              return;
            }

            chatState.enabled = true;
            chatState.mode = desiredMode;
            // Default to at least 2 rounds in exchange mode (more lively by default).
            chatState.rounds = Math.min(3, Math.max(chatState.rounds ?? DEFAULTS.rounds, 2));
            saveState(state);
            if (desiredMode === 'trio') {
              await sendTelegram(
                openclaw,
                replyToFor(chatId),
                `三方交流模式: 已开启
- 触发: 每条消息驱动 DeepSeek -> GLM -> Jarvis 接力发言（通过编排器互相可见）
- 当前轮数: ${chatState.rounds}（可发“交流轮数 1/2/3”调整）
- 开场: 发送“开场三方互聊”
- 关闭: 发送“关闭交流模式”`,
              );
            } else {
              await sendTelegram(
                openclaw,
                replyToFor(chatId),
                `交流模式: 已开启
- 触发: 每条消息驱动 DeepSeek <-> GLM 轮流发言（通过编排器互相可见）
- 当前轮数: ${chatState.rounds}（可发“交流轮数 1/2/3”调整）
- 开场: 发送“开场互聊”
- 关闭: 发送“关闭交流模式”`,
              );
            }

            try {
              await driveTurns({
                chatId,
                sessionKey: sess.sessionKey,
                userText: desiredMode === 'trio' ? KICKOFF_TRIO_USER_TEXT : KICKOFF_DUO_USER_TEXT,
                roundsOverride: Math.min(3, Math.max(2, chatState.rounds ?? 2)),
                modeOverride: desiredMode,
              });
            } catch (err) {
              log(`kickoff error chat=${chatId}: ${String(err)}`);
              await sendTelegram(openclaw, replyToFor(chatId), `开场互聊失败: ${String(err)}`);
            }

            return;
          }
          if (cmd.kind === 'kickoff') {
            const desiredMode = cmd.mode === 'trio' ? 'trio' : chatState.mode ?? 'duo';
            try {
              await Promise.all([
                patchSession(deepseek, 'deepseek', {
                  key: sess.sessionKey,
                  groupActivation: 'mention',
                }),
                patchSession(glm, 'glm', {
                  key: sess.sessionKey,
                  groupActivation: 'mention',
                }),
              ]);
            } catch (err) {
              log(`failed to kickoff xchat (session patch): ${String(err)}`);
              await sendTelegram(openclaw, replyToFor(chatId), `开场互聊失败: ${String(err)}`);
              return;
            }

            chatState.enabled = true;
            chatState.mode = desiredMode;
            chatState.rounds = Math.min(3, Math.max(chatState.rounds ?? DEFAULTS.rounds, 2));
            saveState(state);
            await sendTelegram(
              openclaw,
              replyToFor(chatId),
              `${desiredMode === 'trio' ? '开场三方互聊' : '开场互聊'}开始（${chatState.rounds}轮）`,
            );

            try {
              await driveTurns({
                chatId,
                sessionKey: sess.sessionKey,
                userText: desiredMode === 'trio' ? KICKOFF_TRIO_USER_TEXT : KICKOFF_DUO_USER_TEXT,
                roundsOverride: Math.min(3, Math.max(2, chatState.rounds ?? 2)),
                modeOverride: desiredMode,
              });
            } catch (err) {
              log(`kickoff error chat=${chatId}: ${String(err)}`);
              await sendTelegram(openclaw, replyToFor(chatId), `开场互聊失败: ${String(err)}`);
            }

            return;
          }
          if (cmd.kind === 'off') {
            try {
              await Promise.all([
                patchSession(deepseek, 'deepseek', {
                  key: sess.sessionKey,
                  groupActivation: null,
                }),
                patchSession(glm, 'glm', {
                  key: sess.sessionKey,
                  groupActivation: null,
                }),
              ]);
            } catch (err) {
              log(`failed to disable xchat (session patch): ${String(err)}`);
              await sendTelegram(openclaw, replyToFor(chatId), `交流模式关闭失败: ${String(err)}`);
              return;
            }

            chatState.enabled = false;
            saveState(state);
            await sendTelegram(openclaw, replyToFor(chatId), '交流模式: 已关闭');
            return;
          }
          if (cmd.kind === 'status') {
            await sendTelegram(
              openclaw,
              replyToFor(chatId),
              `交流模式: ${chatState.enabled ? '开启' : '关闭'}\n- 模式: ${chatState.mode ?? 'duo'}\n- 轮数: ${chatState.rounds}\n- 冷却: ${chatState.cooldownMs}ms`,
            );
            return;
          }
          if (cmd.kind === 'rounds') {
            chatState.rounds = cmd.rounds;
            saveState(state);
            await sendTelegram(openclaw, replyToFor(chatId), `交流轮数已设置为 ${cmd.rounds}`);
            return;
          }
        }

        if (!chatState.enabled) return;
        if (isControlCommand(text)) return; // don't hijack /model etc

        if (inFlight.get(chatId)) {
          log(`skip: inFlight chat=${chatId}`);
          return;
        }

        const now = Date.now();
        if (now - (chatState.lastTriggerAt ?? 0) < chatState.cooldownMs) {
          log(`skip: cooldown chat=${chatId}`);
          return;
        }
        chatState.lastTriggerAt = now;

        const tsList = recent.get(chatId) ?? [];
        const windowStart = now - 60_000;
        const nextList = tsList.filter((t) => t >= windowStart);
        nextList.push(now);
        recent.set(chatId, nextList);
        if (nextList.length > DEFAULTS.maxTriggersPerMinute) {
          log(`skip: rateLimit chat=${chatId} count=${nextList.length}`);
          return;
        }

        inFlight.set(chatId, true);
        saveState(state);

        try {
          const sessionKey = sess.sessionKey;
          await driveTurns({ chatId, sessionKey, userText: text });
        } catch (err) {
          log(`exchange error chat=${chatId}: ${String(err)}`);
          try {
            await sendTelegram(openclaw, replyToFor(chatId), `交流模式出错: ${String(err)}`);
          } catch {
            // ignore
          }
        } finally {
          inFlight.set(chatId, false);
          saveState(state);
        }
      },
    });

    // We tail from end to avoid replaying old history on restart.
    tailer.start({ fromEnd: true });
    tailers.push(tailer);

    log(`chat state chat=${chatId} enabled=${chatState.enabled} rounds=${chatState.rounds}`);
  }

  process.on('SIGINT', () => {
    log('SIGINT received; shutting down');
    for (const t of tailers) t.stop();
    openclaw.stop();
    deepseek.stop();
    glm.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('SIGTERM received; shutting down');
    for (const t of tailers) t.stop();
    openclaw.stop();
    deepseek.stop();
    glm.stop();
    process.exit(0);
  });

  // Keep alive.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await delay(60_000);
  }
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  process.exit(1);
});
