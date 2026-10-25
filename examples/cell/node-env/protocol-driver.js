// Turnstile widget protocol driver skeleton.
// Source of truth: traces/round12-payload/postmessage-protocol.json (323 msgs)
// + traces/round13-seed/execute-challenge-seed.json (challenge seed shape).
//
// The parent (chl_page orchestrate) and the widget (challenges.cloudflare.com
// iframe) exchange messages with common fields:
//   { source: 'cloudflare-challenge', widgetId: '<id>', event: '<type>', ... }
// Heartbeat: widget sends `meow`(seq++), parent answers `food`(same seq).
// Lifecycle (parent -> widget):
//   extraParams {action:'managed', apiJsResourceTiming:<PerfResourceTiming>, ...}
//   translationInit {displayLanguage, ...}
//   execute {cs: [[0, <difficulty:number>, <stack-proof:string>, <flag:number>]]}
// Widget -> parent:
//   init {mode:'managed', nextRcV:'<token>-<ts>-1.3.1.1-<sig>'}
//   requestExtraParams {} / overrunBegin {} / complete callbacks
//
// Next session: instantiate this against harness's pseudo-iframe realm and
// feed the 824KB payload (round3 values/05e7*.txt) inside it; the payload's
// PoW loop solves `cs[0][1]` iterations (difficulty, e.g. 39974) seeded by
// the stack proof string; round8/9 VM windows are the instruction baseline.
'use strict';

function msg(widgetId, event, extra) {
  return Object.assign({ source: 'cloudflare-challenge', widgetId, event }, extra || {});
}

class ProtocolDriver {
  constructor({ widgetId, sendToWidget, sendToParent, log }) {
    this.widgetId = widgetId || 'w' + Math.random().toString(36).slice(2, 7);
    this.sendToWidget = sendToWidget;  // (message) => void
    this.sendToParent = sendToParent;  // (message) => void
    this.log = log || (() => {});
    this.seq = 0;
    this.heartbeatTimer = null;
  }

  // Widget side: emit `meow`, expect `food` with the same seq.
  startHeartbeat(intervalMs) {
    this.heartbeatTimer = setInterval(() => {
      this.seq += 1;
      this.log(`meow seq=${this.seq}`);
      this.sendToParent(msg(this.widgetId, 'meow', { seq: this.seq }));
    }, intervalMs || 1500);
  }

  // Parent side: answer a heartbeat.
  onMessageFromWidget(m) {
    if (m.event === 'meow') {
      this.sendToWidget(msg(this.widgetId, 'food', { seq: m.seq }));
    } else if (m.event === 'init' || m.event === 'requestExtraParams' ||
               m.event === 'overrunBegin') {
      this.log(`widget->parent ${m.event}`, m);
    }
  }

  // Parent side lifecycle toward the widget.
  sendExtraParams(apiJsTiming) {
    this.sendToWidget(msg(this.widgetId, 'extraParams', Object.assign({
      action: 'managed',
      apiJsMismatchReloadAttempts: 0,
      apiJsMismatchReloadCompletedCount: 0,
    }, apiJsTiming ? { apiJsResourceTiming: apiJsTiming } : {})));
  }

  sendTranslationInit(language) {
    this.sendToWidget(msg(this.widgetId, 'translationInit', {
      displayLanguage: language || 'zh-CN',
    }));
  }

  sendExecute(difficulty, stackProof, flag) {
    this.sendToWidget(msg(this.widgetId, 'execute', {
      cs: [[0, difficulty, stackProof, flag == null ? 1 : flag]],
    }));
  }

  stop() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); }
}

module.exports = { ProtocolDriver, msg };
