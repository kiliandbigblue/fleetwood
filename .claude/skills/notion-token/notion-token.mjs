#!/usr/bin/env node
/*
 * Keep the Notion token the plan view reads in good shape.
 *
 *   node notion-token.mjs check     is the stored access token still accepted?
 *   node notion-token.mjs refresh   trade the refresh token for a new pair
 *   node notion-token.mjs login     sign in again in the browser
 *
 * Everything lives in the login Keychain, under the services below. A token is
 * never printed: `notion.tokenCommand` reads it straight from the Keychain.
 *
 * Notion rotates the refresh token on every refresh, so the new pair is saved
 * before anything else happens — a refresh whose answer is lost is a sign-in.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const CLIENT_ID = process.env.FLEETWOOD_NOTION_CLIENT_ID ?? '3f3d872b-594c-81fc-b79a-00379742640a';
// Sent unencoded on the authorize link: Notion compares it as raw text with the token request's.
const REDIRECT = 'http://localhost:53682/callback';
const ACCESS = 'fleetwood-notion-token';
const REFRESH = 'fleetwood-notion-refresh-token';
const SECRET = 'fleetwood-notion-client-secret';

function keychainRead(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-w', '-s', service], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function keychainWrite(service, value) {
  execFileSync('security', ['add-generic-password', '-U', '-a', process.env.USER, '-s', service, '-w', value]);
}

function need(service, hint) {
  const value = keychainRead(service);
  if (value) return value;
  console.error(`missing Keychain item ${service} — ${hint}`);
  process.exit(1);
}

async function tokenRequest(body) {
  const secret = need(SECRET, 'save the connection\'s client secret first (see SKILL.md)');
  const res = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const answer = await res.json();
  if (!res.ok) {
    console.error(`Notion refused: ${answer.error} — ${answer.error_description ?? ''}`);
    process.exit(1);
  }
  keychainWrite(ACCESS, answer.access_token);
  if (answer.refresh_token) keychainWrite(REFRESH, answer.refresh_token);
  console.log(`stored a new token for ${answer.workspace_name ?? 'the workspace'}`);
}

async function check() {
  const token = need(ACCESS, 'run `login`');
  const res = await fetch('https://api.notion.com/v1/users/me', {
    headers: { authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  });
  if (res.ok) return console.log('token ok');
  console.log(`token refused (${res.status}) — run \`refresh\`, or \`login\` if that fails`);
  process.exit(1);
}

async function refresh() {
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: need(REFRESH, 'run `login`') });
}

function login() {
  const link = `https://api.notion.com/v1/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&owner=user&redirect_uri=${REDIRECT}`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== '/callback') return void res.writeHead(404).end();
    const code = url.searchParams.get('code');
    server.close();
    if (!code) {
      res.end(`Fleetwood: ${url.searchParams.get('error')}`);
      console.error(`sign-in refused: ${url.searchParams.get('error')}`);
      process.exit(1);
    }
    // At once: a code is short-lived and spent by its first exchange, even a failed one.
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    res.end('Fleetwood: signed in, you can close this tab.');
  });
  server.listen(53682, '127.0.0.1', () => {
    console.log('opening the Notion sign-in — pick Bigblue, share the Tasks Database and Milestones');
    execFileSync('open', [link]);
  });
  setTimeout(() => {
    console.error('no sign-in within 10 minutes');
    process.exit(1);
  }, 10 * 60_000).unref();
}

const commands = { check, refresh, login };
const command = commands[process.argv[2]];
if (!command) {
  console.error('usage: notion-token.mjs check | refresh | login');
  process.exit(2);
}
await command();
