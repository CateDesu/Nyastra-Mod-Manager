import crypto from "crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import * as querystring from "node:querystring";
import * as url from "node:url";

import { BRAND_NAME, SERVICE_NAME, PROGRAM_NAME, unknownToError } from "@vortex/shared";

import { ArgumentInvalid } from "../../../util/CustomErrors";
import getVortexPath from "../../../util/getVortexPath";
import { log } from "../../../util/log";
import {
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URL,
  OAUTH_REDIRECT_BASE,
  OAUTH_URL,
  getOAuthRedirectUrl,
} from "../constants";

type TokenType = "Bearer";

// see https://www.oauth.com/oauth2-servers/access-tokens/access-token-response/
type TokenErrorType =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type";

export interface ITokenReply {
  access_token: string;
  token_type: TokenType;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface IOAuthServerSettings {
  baseUrl: string;
  clientId: string;
  redirectUrl: string; // Deprecated - for backward compatibility
  getRedirectUrl?: (port: number) => string; // New way to get redirect URL
}

function makeResultPage(success: boolean) {
  const html = [];
  const logo = readFileSync(path.join(getVortexPath("assets"), "images", "nyastra.png")).toString(
    "base64",
  );

  html.push(
    `<!DOCTYPE html>

    <html lang="en">
    
    <head>
    <title>Authentication Status</title>
    
      <meta http-equiv="refresh" content="6; url=http://www.nexusmods.com/" />
    
    </head>
    
    <body style="display: flex; flex-direction: column; height: 50vh; justify-content: center; align-items: center; background-color: black; font-family: sans-serif; color: white;">
    
    <div style="text-align: center; ">
    
    <img alt="" width="64" height="64" src="data:image/png;base64,${logo}" />
    <h1 style="color: #D98F40;">${BRAND_NAME}</h1>`,
  );

  if (success) {
    html.push(`
    <h1>${PROGRAM_NAME} log in successful!</h1>
  `);
  } else {
    html.push(`
    <h1>${PROGRAM_NAME} was unable to log in</h1>
    <p style="font-size: 1.2em;">Please check ${PROGRAM_NAME} for more information</p>
  `);
  }

  html.push(`

  <p style="font-size: 1.2em;">Taking you to the <a href="http://www.nexusmods.com/" style="color: #D98F40;">${SERVICE_NAME} homepage</a></p>
    </div>
    </body>
    
    </html>
  `);

  return html.join("");
}

async function postRequest(tokenUrl: string, request: any): Promise<string> {
  const requestStr = querystring.stringify(request);
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(tokenUrl);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Content-Length": requestStr.length,
        },
      },
      (res) => {
        let responseStr = "";
        res
          .on("data", (chunk) => (responseStr += chunk.toString()))
          .on("error", reject)
          .on("aborted", () => reject(new Error("Token response was interrupted")))
          .on("end", () => {
            if (res.statusCode !== 200) {
              try {
                const errDetails = JSON.parse(responseStr);
                const err = new Error(`Invalid request: "${errDetails?.error}"`);
                err["code"] = errDetails?.error;
                // these details are explicitly intended for the developer, not for the user
                err["details"] = errDetails?.error_description;
                reject(err);
              } catch (err) {
                const errMessage = responseStr.includes("<!DOCTYPE html>")
                  ? `Received HTML response from ${tokenUrl} when JSON was expected. Please check your connection settings.`
                  : `Failed to parse failure response: "${responseStr.substring(0, 50)}"`;
                reject(new Error(errMessage));
              }
            } else {
              resolve(responseStr);
            }
          });
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error("Token request timed out")), 30_000);
    req.once("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.write(requestStr);
    req.end();
  });
}

/** Trade a refresh token for a new token pair (RFC 6749 §6). */
export async function requestTokenRefresh(refreshToken: string): Promise<ITokenReply> {
  const reply = await postRequest(`${OAUTH_URL}/token`, {
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  return JSON.parse(reply);
}

/**
 * deals with token exchange for OAuth2
 **/
class OAuth {
  private mServerSettings: IOAuthServerSettings;
  private mStates: {
    [state: string]: {
      callback: (err: Error, token: ITokenReply) => void;
      verifier: string;
      redirectUrl: string;
    };
  } = Object.create(null);
  private mServer: http.Server;
  private mServerStarted: Promise<void>;
  private mLocalhost: boolean;

  constructor(settings: IOAuthServerSettings) {
    this.mServerSettings = settings;
    // Check if we're using localhost redirect (http protocol)
    this.mLocalhost = OAUTH_REDIRECT_BASE.startsWith("http:");
  }

  public async sendRequest(
    onToken: (err: Error, token: ITokenReply) => void,
    onOpenPage: (url: string) => void,
  ): Promise<void> {
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const request = { callback: onToken, verifier, redirectUrl: "" };
    this.mStates[state] = request;

    try {
      const port = this.mLocalhost ? await this.ensureServer() : -1;
      request.redirectUrl = this.mServerSettings.getRedirectUrl
        ? this.mServerSettings.getRedirectUrl(port)
        : this.mServerSettings.redirectUrl.replace("PORT", port.toString());
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      onOpenPage(this.authorizeUrl(challenge, state, request.redirectUrl));
    } catch (err) {
      delete this.mStates[state];
      this.checkServerStillRequired();
      log("error", "failed to start server", err);
      throw err;
    }
  }

  public async receiveCode(code: string, state?: string): Promise<void> {
    if (state === undefined) {
      for (const key of Object.keys(this.mStates)) {
        await this.receiveCode(code, key);
      }
    } else {
      await this.exchangeCode(code, state);
    }
  }

  private async exchangeCode(code: string, state: string): Promise<boolean> {
    const request = this.mStates[state];
    if (request === undefined) {
      // State token not found — the callback arrived after the login flow was
      // already completed or abandoned (e.g. the user clicked login twice).
      // Silently ignore, matching the behavior of the local HTTP server path.
      log("debug", "ignoring OAuth callback with unknown state token", { state });
      return false;
    }
    // Claim the callback before awaiting so it can only be exchanged once.
    delete this.mStates[state];
    try {
      const tokenReply = await this.sentAuthorizeToken(code, request.verifier, request.redirectUrl);
      request.callback(null, tokenReply);
      return true;
    } catch (unknownError) {
      const err = unknownToError(unknownError);
      request.callback(err, undefined);
      return false;
    } finally {
      this.checkServerStillRequired();
    }
  }

  private async ensureServer(): Promise<number> {
    if (this.mServer === undefined) {
      log("info", "starting localhost server to receive oauth response");
      this.mServerStarted = this.startServer();
    }
    await this.mServerStarted;
    const addr: AddressInfo = this.mServer.address() as AddressInfo;
    log("info", "using localhost server for oauth response", {
      port: addr.port,
    });
    return addr.port;
  }

  private checkServerStillRequired() {
    if (this.mLocalhost && Object.keys(this.mStates).length === 0) {
      log("info", "no more oauth responses outstanding, stopping server");
      this.stopServer();
    }
  }

  private stopServer() {
    this.mServer?.close?.();
    this.mServer = undefined;
  }

  private async startServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.mServer = http
          .createServer()
          .listen(undefined, "127.0.0.1")
          .on("error", reject)
          .on("listening", resolve)
          .on("request", (req, resp) => {
            void this.onHTTPRequest(req, resp).catch((error: unknown) => {
              log("error", "OAuth callback failed", error);
              if (!resp.headersSent) resp.statusCode = 500;
              resp.end();
            });
          });
      } catch (err) {
        reject(err);
      }
    });
  }

  private async onHTTPRequest(
    req: http.IncomingMessage,
    resp: http.ServerResponse<http.IncomingMessage> & {
      req: http.IncomingMessage;
    },
  ) {
    if (req.method !== "GET") {
      resp.statusCode = 405;
      resp.setHeader("Allow", "GET");
      resp.end();
      return;
    }
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    const queryItems = Object.fromEntries(parsedUrl.searchParams);
    const getQueryParam = (key: string): string => {
      const tmp = queryItems[key];
      return Array.isArray(tmp) ? tmp[0] : tmp;
    };
    const code = getQueryParam("code");
    const state = getQueryParam("state");
    const error = getQueryParam("error");
    const error_description = getQueryParam("error_description");

    if (code !== undefined && state !== undefined) {
      const success = await this.exchangeCode(code, state);
      resp.statusCode = success ? 200 : 400;
      resp.write(makeResultPage(success));
    } else if (error !== undefined) {
      const err = new Error(error_description ?? "Description missing");
      err["code"] = error;
      this.mStates[state]?.callback(err, undefined);
      resp.write(makeResultPage(false));
      delete this.mStates[state];

      this.checkServerStillRequired();
    }

    resp.end();
  }

  private authorizeUrl(challenge: string, state: string, redirectUrl: string): string {
    const request = {
      response_type: "code",
      scope: "openid profile email",
      code_challenge_method: "S256",
      client_id: this.mServerSettings.clientId,
      redirect_uri: redirectUrl,
      state,
      code_challenge: challenge,
    };
    return `${this.mServerSettings.baseUrl}/authorize?${querystring.stringify(request)}`;
  }

  private async sentAuthorizeToken(
    code: string,
    verifier: string,
    redirectUrl: string,
  ): Promise<ITokenReply> {
    const request = {
      grant_type: "authorization_code",
      client_id: this.mServerSettings.clientId,
      redirect_uri: redirectUrl,
      code,
      code_verifier: verifier,
    };
    const tokenUrl = `${this.mServerSettings.baseUrl}/token`;
    // TODO: validate result
    return JSON.parse(await postRequest(tokenUrl, request));
  }
}

export default OAuth;
