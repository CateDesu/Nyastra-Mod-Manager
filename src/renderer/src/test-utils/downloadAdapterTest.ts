import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { vi } from "vitest";

import { IPCDownloadAdapter } from "../IPCDownloadAdapter";
import { makeDownloadAdapterHarness } from "./builders";
import { test as harnessTest } from "./harnessTest";
import type { IDownloadAdapterHarness, IDownloadAdapterOpts } from "./harnessTypes";

export interface IDownloadAdapterFixtures {
  // build a harness around the REAL IPCDownloadAdapter over one seeded download (mocks the
  // window.api.downloader IPC seam; the fixture restores window.api and real timers on teardown)
  makeDownloadAdapter: (opts?: IDownloadAdapterOpts) => IDownloadAdapterHarness;
}

/**
 * Base test for IPCDownloadAdapter suites. Extends the shared harnessTest with a
 * `makeDownloadAdapter` factory bound to the real adapter, and owns the two bits of lifecycle the
 * adapter needs: fake timers (its constructor starts a 200ms poll loop that must never fire on its
 * own) and the window.api global the harness replaces with the downloader mock. Both are set up
 * before the factory runs and torn down after the test, so no suite writes its own beforeEach /
 * afterEach. Separate from harnessTest on purpose: it imports the adapter, so only adapter suites
 * pay that cost.
 */
export const test = harnessTest.extend<IDownloadAdapterFixtures>({
  makeDownloadAdapter: async ({ task: _task }, provide) => {
    const savedApi = window.api;
    const downloadDirectory = await mkdtemp(path.join(tmpdir(), "nyastra-download-test-"));
    vi.useFakeTimers();
    try {
      await provide((opts?: IDownloadAdapterOpts) =>
        makeDownloadAdapterHarness(IPCDownloadAdapter, { downloadDirectory, ...opts }),
      );
    } finally {
      vi.useRealTimers();
      window.api = savedApi;
      await rm(downloadDirectory, { recursive: true, force: true });
    }
  },
});
