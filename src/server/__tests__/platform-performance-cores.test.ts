import { describe, expect, it, vi } from "vitest";
import {
  parseCpuSetInformation,
  readPerformanceCoreSetting,
  runOnPerformanceCores,
  selectPerformanceCoreMask,
  type LogicalProcessor,
  type WindowsProcessorApi,
} from "../platform.js";

/** One 32-byte SYSTEM_CPU_SET_INFORMATION record per logical processor, as Windows returns them. */
function cpuSetRecords(processors: LogicalProcessor[]): Buffer {
  const records = Buffer.alloc(processors.length * 32);
  processors.forEach((processor, position) => {
    const offset = position * 32;
    records.writeUInt32LE(32, offset);
    records.writeUInt32LE(0, offset + 4);
    records.writeUInt32LE(0x100 + position, offset + 8);
    records.writeUInt16LE(processor.group, offset + 12);
    records.writeUInt8(processor.index, offset + 14);
    records.writeUInt8(processor.core, offset + 15);
    records.writeUInt8(processor.efficiencyClass, offset + 18);
  });
  return records;
}

/** Eight performance cores with two threads each, then four efficiency cores (Core i7-12700K). */
function hybridProcessors(): LogicalProcessor[] {
  const performance = Array.from({ length: 16 }, (_, index) => ({ index, core: index - (index % 2), group: 0, efficiencyClass: 1 }));
  const efficiency = Array.from({ length: 4 }, (_, offset) => ({ index: 16 + offset, core: 16 + offset, group: 0, efficiencyClass: 0 }));
  return [...performance, ...efficiency];
}

function uniformProcessors(count: number): LogicalProcessor[] {
  return Array.from({ length: count }, (_, index) => ({ index, core: index - (index % 2), group: 0, efficiencyClass: 0 }));
}

function processorApi(processors: LogicalProcessor[], accept = true) {
  return {
    getCurrentProcess: vi.fn(() => "handle"),
    readCpuSets: vi.fn((): Uint8Array | undefined => cpuSetRecords(processors)),
    setProcessAffinityMask: vi.fn((_process: unknown, _mask: bigint) => accept),
  } satisfies WindowsProcessorApi;
}

describe("parseCpuSetInformation", () => {
  it("reads every record and stops at a truncated one", () => {
    const processors = hybridProcessors();
    expect(parseCpuSetInformation(cpuSetRecords(processors))).toEqual(processors);
    expect(parseCpuSetInformation(cpuSetRecords(processors).subarray(0, 32 * 3 + 10))).toEqual(processors.slice(0, 3));
    expect(parseCpuSetInformation(Buffer.alloc(64))).toEqual([]);
  });

  it("follows each record's own size and skips record kinds it does not know", () => {
    const wide = Buffer.alloc(40 + 32);
    wide.writeUInt32LE(40, 0);
    wide.writeUInt32LE(7, 4);
    cpuSetRecords([{ index: 5, core: 4, group: 0, efficiencyClass: 1 }]).copy(wide, 40);
    expect(parseCpuSetInformation(wide)).toEqual([{ index: 5, core: 4, group: 0, efficiencyClass: 1 }]);
  });
});

describe("selectPerformanceCoreMask", () => {
  it("selects both threads of every performance core and no efficiency core", () => {
    expect(selectPerformanceCoreMask(hybridProcessors())).toBe(0xffffn);
  });

  it("keeps the last cores when fewer are wanted", () => {
    expect(selectPerformanceCoreMask(hybridProcessors(), 6)).toBe(0xfff0n);
    expect(selectPerformanceCoreMask(hybridProcessors(), 1)).toBe(0xc000n);
    expect(selectPerformanceCoreMask(hybridProcessors(), 20)).toBe(0xffffn);
  });

  it("has nothing to select unless the CPU mixes core kinds within one processor group", () => {
    expect(selectPerformanceCoreMask(uniformProcessors(16))).toBeUndefined();
    expect(selectPerformanceCoreMask([])).toBeUndefined();
    const twoGroups = hybridProcessors().map((processor) => ({ ...processor, group: processor.index < 16 ? 0 : 1 }));
    expect(selectPerformanceCoreMask(twoGroups)).toBeUndefined();
  });

  it("treats only the fastest class as performance cores", () => {
    const threeClasses: LogicalProcessor[] = [
      { index: 0, core: 0, group: 0, efficiencyClass: 2 },
      { index: 1, core: 0, group: 0, efficiencyClass: 2 },
      { index: 2, core: 2, group: 0, efficiencyClass: 1 },
      { index: 3, core: 3, group: 0, efficiencyClass: 0 },
    ];
    expect(selectPerformanceCoreMask(threeClasses)).toBe(0b11n);
  });
});

describe("readPerformanceCoreSetting", () => {
  it("defaults to every performance core", () => {
    expect(readPerformanceCoreSetting({})).toEqual({ mode: "all" });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: " " })).toEqual({ mode: "all" });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: "ALL" })).toEqual({ mode: "all" });
  });

  it("reads off, a core count, and rejects anything else", () => {
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: "off" })).toEqual({ mode: "off" });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: "0" })).toEqual({ mode: "off" });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: " 6 " })).toEqual({ mode: "limit", cores: 6 });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: "half" })).toEqual({ mode: "invalid", value: "half" });
    expect(readPerformanceCoreSetting({ BRIDGE_PERFORMANCE_CORES: "-2" })).toEqual({ mode: "invalid", value: "-2" });
  });
});

describe("runOnPerformanceCores", () => {
  it("does nothing off Windows", async () => {
    const api = processorApi(hybridProcessors());
    await expect(runOnPerformanceCores({ platform: "linux", env: {}, loadApi: async () => api }))
      .resolves.toEqual({ applied: false, detail: "not windows" });
    expect(api.readCpuSets).not.toHaveBeenCalled();
  });

  it("restricts the process to the performance cores of a hybrid CPU", async () => {
    const api = processorApi(hybridProcessors());
    await expect(runOnPerformanceCores({ platform: "win32", env: {}, loadApi: async () => api }))
      .resolves.toEqual({ applied: true, detail: "16 of 20 logical processors (mask 0xffff)" });
    expect(api.setProcessAffinityMask).toHaveBeenCalledWith("handle", 0xffffn);
  });

  it("uses only as many cores as the setting allows", async () => {
    const api = processorApi(hybridProcessors());
    const result = await runOnPerformanceCores({ platform: "win32", env: { BRIDGE_PERFORMANCE_CORES: "4" }, loadApi: async () => api });
    expect(result).toEqual({ applied: true, detail: "8 of 20 logical processors (mask 0xff00)" });
    expect(api.setProcessAffinityMask).toHaveBeenCalledWith("handle", 0xff00n);
  });

  it("leaves the process alone when switched off or misconfigured, without loading the native API", async () => {
    const loadApi = vi.fn(async () => processorApi(hybridProcessors()));
    await expect(runOnPerformanceCores({ platform: "win32", env: { BRIDGE_PERFORMANCE_CORES: "off" }, loadApi }))
      .resolves.toEqual({ applied: false, detail: "BRIDGE_PERFORMANCE_CORES=off" });
    await expect(runOnPerformanceCores({ platform: "win32", env: { BRIDGE_PERFORMANCE_CORES: "many" }, loadApi }))
      .resolves.toEqual({ applied: false, detail: "BRIDGE_PERFORMANCE_CORES must be all, off or a number of cores, not \"many\"" });
    expect(loadApi).not.toHaveBeenCalled();
  });

  it("leaves a CPU with one kind of core alone", async () => {
    const api = processorApi(uniformProcessors(16));
    await expect(runOnPerformanceCores({ platform: "win32", env: {}, loadApi: async () => api }))
      .resolves.toEqual({ applied: false, detail: "this CPU has no separate performance cores" });
    expect(api.setProcessAffinityMask).not.toHaveBeenCalled();
  });

  it("reports why nothing was applied instead of throwing", async () => {
    const silent = processorApi(hybridProcessors());
    silent.readCpuSets.mockReturnValue(undefined);
    await expect(runOnPerformanceCores({ platform: "win32", env: {}, loadApi: async () => silent }))
      .resolves.toEqual({ applied: false, detail: "Windows did not report its processors" });

    const refused = processorApi(hybridProcessors(), false);
    await expect(runOnPerformanceCores({ platform: "win32", env: {}, loadApi: async () => refused }))
      .resolves.toEqual({ applied: false, detail: "Windows refused processor mask 0xffff" });

    await expect(runOnPerformanceCores({ platform: "win32", env: {}, loadApi: async () => { throw new Error("no koffi"); } }))
      .resolves.toEqual({ applied: false, detail: "no koffi" });
  });
});
