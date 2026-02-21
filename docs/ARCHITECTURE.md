# Architecture

## Problem

Telegram Bot API typically does not deliver bot-to-bot messages, which makes a true "AI agents talking to each other" group conversation impossible if implemented purely inside Telegram.

However, users still want the *effect* of multi-agent discussion: each model should be able to see and respond to the others.

## Approach

Use a local orchestrator process that:

1. Tails the OpenClaw session transcript (`.jsonl`) for a Telegram group
2. Detects user messages and control commands
3. Calls multiple local OpenClaw gateways (`agent` method) in a fixed sequence
4. Injects previous outputs into the next prompt (bridge memory)
5. Delivers each model's response back to the same Telegram group

This simulates "mutual visibility" while respecting Telegram constraints.

## Components

- **OpenClaw gateway** (listener + sender)
  - Maintains the group session JSONL that the orchestrator tails.
  - Provides a gateway API used by the orchestrator to send messages.

- **DeepSeek gateway** (agent)
  - Runs a model optimized for reasoning or fast iteration.
  - In exchange mode, its group auto-replies are set to `groupActivation: mention` to avoid duplicate replies.

- **GLM gateway** (agent)
  - Runs a complementary model.
  - Also patched to `groupActivation: mention` in exchange mode.

- **Orchestrator** (this repo)
  - State: a small `state.json` storing enabled/mode/rounds and "bridge" memory.
  - Modes:
    - `duo`: DeepSeek <-> GLM
    - `trio`: DeepSeek -> GLM -> Jarvis (OpenClaw)

## Session Patching

When exchange mode is enabled, the orchestrator patches the DeepSeek/GLM session entry:

- `groupActivation: "mention"`

In OpenClaw (legacy Clawdbot) Telegram implementation, group activation influences whether the bot requires mention. This is used as a guardrail to prevent DeepSeek/GLM from responding directly to every group message while the orchestrator is already driving turns.

## Limitations

- Not a real Telegram bot-to-bot message feed.
- The "mutual visibility" is entirely prompt-based.
- If your group is extremely chatty, rate limiting and cooldown may skip triggers.
