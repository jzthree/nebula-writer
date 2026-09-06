/**
 * Capability-URL authentication for sharing mode.
 *
 * When the sidecar binds beyond loopback (npm run dev:share), it generates a
 * crypto-random token. The share link embeds it as a URL fragment
 * (http://host:5173/#share=<token>); the web app stores it and presents it on
 * every API request (X-Writer-Share-Token header) and websocket upgrade
 * (?token= query param). Requests that arrive from this machine itself stay
 * trusted without a token, so the owner's localhost browser needs no setup.
 *
 * Trust rule for "local": the TCP peer is loopback AND every X-Forwarded-For
 * entry (appended by the Vite dev proxy) is loopback too. A LAN client cannot
 * spoof this: connecting directly it has a non-loopback peer address, and
 * through the proxy its real address is appended to the forwarded chain.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

let generatedToken: string | null = null;

export function isShareModeEnabled(): boolean {
  const host = process.env.WRITER_HOST || "127.0.0.1";
  return host !== "127.0.0.1" && host !== "localhost";
}

export function getShareToken(): string | null {
  if (!isShareModeEnabled()) {
    return null;
  }
  const override = process.env.WRITER_SHARE_TOKEN?.trim();
  if (override) {
    return override;
  }
  if (!generatedToken) {
    // 32 random bytes -> 43-char base64url token: far beyond guessable.
    generatedToken = randomBytes(32).toString("base64url");
  }
  return generatedToken;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function requestIsLocal(request: IncomingMessage): boolean {
  const peer = request.socket.remoteAddress ?? "";
  if (!isLoopbackAddress(peer)) {
    return false;
  }
  const forwarded = request.headers["x-forwarded-for"];
  if (!forwarded) {
    return true;
  }
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded).split(",");
  return chain.every((entry) => isLoopbackAddress(entry));
}

export function tokenMatches(candidate: string | undefined | null): boolean {
  const token = getShareToken();
  if (!token || !candidate) {
    return false;
  }
  const expected = Buffer.from(token);
  const provided = Buffer.from(candidate);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function requestShareToken(request: IncomingMessage): string | null {
  const header = request.headers["x-writer-share-token"];
  if (typeof header === "string" && header) {
    return header;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

/** Express middleware guarding the HTTP API while sharing mode is active. */
export function shareAuthMiddleware(request: Request, response: Response, next: NextFunction): void {
  if (!isShareModeEnabled() || requestIsLocal(request) || tokenMatches(requestShareToken(request))) {
    next();
    return;
  }
  response.status(401).json({
    error: "This shared Writer requires the share link's access token. Open the full share link (it ends with #share=...) instead of the bare address."
  });
}

/** Same guard for websocket upgrades; returns true when the socket may proceed. */
export function upgradeIsAuthorized(request: IncomingMessage): boolean {
  return !isShareModeEnabled() || requestIsLocal(request) || tokenMatches(requestShareToken(request));
}
