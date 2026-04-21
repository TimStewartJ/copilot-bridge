import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "./helpers.js";

const getBridgeGitRevisionsMock = vi.hoisted(() => vi.fn());
const createBridgeGitRevisionReaderMock = vi.hoisted(() => vi.fn(() => getBridgeGitRevisionsMock));

vi.mock("../git-revisions.js", () => ({
  createBridgeGitRevisionReader: createBridgeGitRevisionReaderMock,
}));

let app: Express;

beforeEach(() => {
  createBridgeGitRevisionReaderMock.mockReset();
  getBridgeGitRevisionsMock.mockReset();
  createBridgeGitRevisionReaderMock.mockReturnValue(getBridgeGitRevisionsMock);
  ({ app } = createTestApp());
});

describe("server commit metadata route", () => {
  it("returns bridge commit metadata and forwards refresh requests", async () => {
    getBridgeGitRevisionsMock.mockResolvedValue({
      local: {
        status: "ok",
        ref: "HEAD",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Latest local commit",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: "2222222222222222222222222222222222222222",
        shortSha: "2222222",
        message: "Latest remote commit",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: "3333333333333333333333333333333333333333",
        shortSha: "3333333",
        message: "Running bridge commit",
      },
    });

    const res = await request(app).get("/api/server/commits?refresh=1");

    expect(res.status).toBe(200);
    expect(createBridgeGitRevisionReaderMock).toHaveBeenCalledTimes(1);
    expect(getBridgeGitRevisionsMock).toHaveBeenCalledWith({ forceRefresh: true });
    expect(res.body).toEqual({
      local: {
        status: "ok",
        ref: "HEAD",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Latest local commit",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: "2222222222222222222222222222222222222222",
        shortSha: "2222222",
        message: "Latest remote commit",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: "3333333333333333333333333333333333333333",
        shortSha: "3333333",
        message: "Running bridge commit",
      },
    });
  });
});
