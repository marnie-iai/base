/**
 * Google sign-in for the IAI sprint board API.
 *
 * The board API currently accepts no auth at all (see grid.py) but the
 * target state, confirmed with Marnie, is Google OAuth as
 * marnie@integratedcoatingservices.com. This follows the same pattern as
 * `gcloud auth login` / `gh auth login`: an installed-app Authorization
 * Code + PKCE flow via a local loopback redirect, with the refresh token
 * cached to disk so it's a one-time login per machine, not per session.
 *
 * IMPORTANT (see the plan's rollback section): do not flip the board API to
 * *require* this auth until this flow has been proven end to end against
 * the live, still-unauthenticated API. Until then this module is inert if
 * IAI_BOARD_OAUTH_CLIENT_ID is unset — callers get a clear error, not a
 * crash.
 */
import { OAuth2Client, Credentials } from "google-auth-library";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import open from "open";

const TOKEN_DIR = path.join(os.homedir(), ".config", "iai-ops-mcp");
const TOKEN_PATH = path.join(TOKEN_DIR, "board-token.json");

// openid+email+profile is enough for the board API to verify identity via
// the ID token; widen this if the API ever needs a custom scope.
const SCOPES = ["openid", "email", "profile"];

export class BoardAuthError extends Error {}

function buildClient(): OAuth2Client {
  const clientId = process.env.IAI_BOARD_OAUTH_CLIENT_ID;
  const clientSecret = process.env.IAI_BOARD_OAUTH_CLIENT_SECRET;
  if (!clientId) {
    throw new BoardAuthError(
      "IAI_BOARD_OAUTH_CLIENT_ID is not set. Confirm with Dev/Alex whether an existing " +
        "Google OAuth Desktop-app client (they mentioned ones for iOps/Engage) already " +
        "covers api.integratedai.com.au, or register a new one in Google Cloud Console, " +
        "then set IAI_BOARD_OAUTH_CLIENT_ID / IAI_BOARD_OAUTH_CLIENT_SECRET."
    );
  }
  return new OAuth2Client({ clientId, clientSecret });
}

function loadCachedCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** Runs the interactive browser login and returns fresh credentials. */
async function interactiveLogin(client: OAuth2Client): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          if (!req.url) return;
          const url = new URL(req.url, "http://127.0.0.1");
          if (url.pathname !== "/oauth2callback") {
            res.writeHead(404).end();
            return;
          }
          const error = url.searchParams.get("error");
          const code = url.searchParams.get("code");
          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body>Sign-in failed: ${error}. You can close this tab.</body></html>`);
            server.close();
            reject(new BoardAuthError(`Google OAuth error: ${error}`));
            return;
          }
          if (!code) {
            res.writeHead(400).end("Missing authorization code.");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body>Signed in to the IAI sprint board. You can close this tab and return to your session.</body></html>"
          );
          server.close();
          const redirectUri = (client as unknown as { _iaiRedirectUri: string })._iaiRedirectUri;
          const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
          resolve(tokens);
        } catch (err) {
          reject(err);
        }
      })();
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      (client as unknown as { _iaiRedirectUri: string })._iaiRedirectUri = redirectUri;

      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
        redirect_uri: redirectUri,
      });

      console.error(
        `Opening browser for Google sign-in (expecting marnie@integratedcoatingservices.com):\n${authUrl}`
      );
      open(authUrl).catch(() => {
        console.error(
          "Could not open a browser automatically. Open this URL manually to sign in:\n" + authUrl
        );
      });
    });

    server.on("error", reject);
  });
}

let cachedClient: OAuth2Client | null = null;

async function getAuthorizedClient(forceLogin: boolean): Promise<OAuth2Client> {
  const client = buildClient();
  const cached = !forceLogin ? loadCachedCredentials() : null;

  if (cached) {
    client.setCredentials(cached);
  } else {
    const tokens = await interactiveLogin(client);
    client.setCredentials(tokens);
    saveCredentials(tokens);
  }

  // Persist any refreshed access token so future processes reuse it too.
  client.on("tokens", (tokens) => {
    saveCredentials({ ...client.credentials, ...tokens });
  });

  cachedClient = client;
  return client;
}

/** Returns a bearer token for the board API, refreshing/caching as needed. */
export async function getAccessToken(): Promise<string> {
  const client = cachedClient ?? (await getAuthorizedClient(false));
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new BoardAuthError(
      "Could not obtain a Google access token for the board API. Run iai_board_login to re-authenticate."
    );
  }
  return token;
}

/** Explicit (re-)login, used by the iai_board_login tool. */
export async function login(force: boolean): Promise<{ email?: string }> {
  const client = await getAuthorizedClient(force || !cachedClient);
  try {
    const accessToken = client.credentials.access_token;
    if (!accessToken) return {};
    const info = await client.getTokenInfo(accessToken);
    return { email: info.email };
  } catch {
    // Token info lookup failing doesn't mean login failed — just no email to report.
    return {};
  }
}
