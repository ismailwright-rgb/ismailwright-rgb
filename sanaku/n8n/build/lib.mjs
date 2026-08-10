// Shared node builders for the T-series workflows.
//
// The workflow JSON is what n8n imports, but it is not what a person should
// edit: it is 400 lines of position coordinates around 30 lines of logic. These
// helpers keep the logic readable and make the guard impossible to fork - every
// workflow inlines the same outbound-guard.js, so a fix lands in all of them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SUPA_AUTH = {
  authentication: 'genericCredentialType',
  genericAuthType: 'httpCustomAuth',
};
export const SUPA_CRED = {
  httpCustomAuth: { id: 'supabase-custom-auth', name: 'Supabase Service Role (Custom Auth)' },
};
export const TWILIO_CRED = { twilioApi: { id: 'twilio-account', name: 'Twilio account' } };
export const OPENROUTER_CRED = {
  httpHeaderAuth: { id: 'openrouter-header-auth', name: 'OpenRouter (Header Auth)' },
};
export const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, alwaysOutputData: true };

/** The guard source, minus its module.exports tail, for inlining into a Code node. */
export function guardSource() {
  const src = readFileSync(join(HERE, '..', 'lib', 'outbound-guard.js'), 'utf8');
  const cut = src.indexOf('// Node can require this for the tests');
  if (cut === -1) throw new Error('outbound-guard.js changed shape - the inline marker is gone');
  return src.slice(0, cut).trim();
}

let seq = 0;
export const nid = (prefix) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export const sticky = (content, position, { width = 620, height = 720, color = 4 } = {}) => ({
  parameters: { content, height, width, color },
  id: nid('e0000000'), name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1, position,
});

export const webhook = (name, path, position) => ({
  parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} },
  id: nid('e1000000'), name, type: 'n8n-nodes-base.webhook', typeVersion: 2,
  position, webhookId: nid('e1100000'),
});

export const schedule = (name, minutes, position) => ({
  parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } },
  id: nid('e1200000'), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position,
});

/** A once-a-day trigger at a fixed local hour. `schedule` above is minutes-only. */
export const dailyAt = (name, hour, position) => ({
  parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: 0 }] } },
  id: nid('e1300000'), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position,
});

/**
 * OpenRouter chat completion. The request body is built UPSTREAM in a Code node
 * and passed through whole, which is how the existing content workflows do it -
 * it keeps the model id, the system prompt and the temperature in readable
 * JavaScript instead of buried in node parameters.
 */
export const openrouter = (name, position, bodyExpr = '={{ $json.requestBody }}') => ({
  parameters: {
    method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'content-type', value: 'application/json' }] },
    sendBody: true, contentType: 'raw', rawContentType: 'application/json',
    body: bodyExpr,
    options: { timeout: 120000 },
  },
  id: nid('e8000000'), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position, credentials: OPENROUTER_CRED, ...RETRY,
});

export const code = (name, jsCode, position, mode = 'runOnceForAllItems') => ({
  parameters: { mode, jsCode },
  id: nid('e2000000'), name, type: 'n8n-nodes-base.code', typeVersion: 2, position,
});

/** An IF whose single condition is a boolean expression. */
export const gate = (name, expr, position, id = 'ok') => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        id, leftValue: `={{ ${expr} }}`, rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  id: nid('e3000000'), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
});

export const supaGet = (name, pathExpr, position) => ({
  parameters: {
    method: 'GET', url: `={{ $env.SUPABASE_URL }}/rest/v1/${pathExpr}`,
    ...SUPA_AUTH, options: { timeout: 15000 },
  },
  id: nid('e4000000'), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position, credentials: SUPA_CRED, ...RETRY,
});

export const supaWrite = (name, method, pathExpr, jsonBody, position, extra = {}) => ({
  parameters: {
    method, url: `={{ $env.SUPABASE_URL }}/rest/v1/${pathExpr}`,
    ...SUPA_AUTH,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Prefer', value: extra.prefer || 'return=representation' }] },
    sendBody: true, specifyBody: 'json', jsonBody,
    options: { timeout: 15000 },
  },
  id: nid('e5000000'), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position, credentials: SUPA_CRED, ...RETRY,
  ...(extra.onError ? { onError: extra.onError } : {}),
});

/** The add-on gate. Every workflow calls this before it acts. */
export const hasAddon = (name, clientIdExpr, code_, position) =>
  supaWrite(name, 'POST', 'rpc/sanaku_has_addon',
    `={{ JSON.stringify({ _client_id: ${clientIdExpr}, _code: ${code_} }) }}`,
    position, { prefer: 'return=representation' });

export const twilioSms = (name, fromExpr, toExpr, msgExpr, position) => ({
  parameters: { resource: 'sms', operation: 'send', from: fromExpr, to: toExpr, message: msgExpr, options: {} },
  id: nid('e6000000'), name, type: 'n8n-nodes-base.twilio', typeVersion: 1,
  position, credentials: TWILIO_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
});

export const respond = (name, body, position) => ({
  parameters: {
    respondWith: 'json', responseBody: `={{ JSON.stringify(${body}) }}`,
    options: { responseCode: 200 },
  },
  id: nid('e7000000'), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position,
});

export const logError = (name, whatExpr, payloadExpr, position) =>
  supaWrite(name, 'POST', 'sanaku_errors',
    `={{ JSON.stringify({ workflow: $workflow.name, error: ${whatExpr}, payload: ${payloadExpr} }) }}`,
    position, { prefer: 'return=minimal' });

export const to = (name, index = 0) => [{ node: name, type: 'main', index }];

export const workflow = (name, nodes, connections) => ({
  name, nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/Los_Angeles' },
  pinData: {}, meta: {},
});
