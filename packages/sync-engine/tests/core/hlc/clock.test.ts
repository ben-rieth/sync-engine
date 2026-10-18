import { describe, expect, it } from "vitest";
import { ClockDriftError, HybridLogicalClock } from "#core/hlc/clock";
import { HLCTimestamp, MAX_LOGICAL } from "#core/hlc/timestamp";
import { elementAt } from "../../helpers";

const NODE = "local";
const REMOTE = "remote";
const DEFAULT_MAX_DRIFT_MS = 5 * 60_000;

const ts = (physical: number, logical: number, nodeId = NODE) =>
  new HLCTimestamp(physical, logical, nodeId);

// A clock whose wall time is controlled by the test through `setTime`.
const createClock = ({
  time = 1000,
  last = null as HLCTimestamp | null,
  maxDriftMs = undefined as number | undefined,
  nodeId = NODE,
} = {}) => {
  let wallTime = time;
  const clock = new HybridLogicalClock(nodeId, {
    last,
    now: () => wallTime,
    maxDriftMs,
  });
  return {
    clock,
    setTime: (value: number) => {
      wallTime = value;
    },
  };
};

const expectTimestamp = (
  actual: HLCTimestamp,
  physical: number,
  logical: number,
  nodeId = NODE,
) => {
  expect(actual.physicalTime).toBe(physical);
  expect(actual.logicalTime).toBe(logical);
  expect(actual.nodeId).toBe(nodeId);
};

const expectGreater = (a: HLCTimestamp, b: HLCTimestamp) => {
  expect(HLCTimestamp.compare(a, b), `${a.toString()} should be greater than ${b.toString()}`).toBe(
    1,
  );
};

const expectIncreasing = (timestamps: HLCTimestamp[]) => {
  let previous: HLCTimestamp | undefined;
  for (const current of timestamps) {
    if (previous !== undefined) {
      expectGreater(current, previous);
    }
    previous = current;
  }
};

// Interleaves ticks from two tabs sharing a nodeId, occasionally advancing
// time, and returns every issued timestamp.
const runTabs = (shareState: boolean) => {
  let wallTime = 1000;
  const now = () => wallTime;
  const firstTab = new HybridLogicalClock(NODE, { now });
  const secondTab = new HybridLogicalClock(NODE, { now });
  let shared: HLCTimestamp | null = null;
  const issued: HLCTimestamp[] = [];

  for (let i = 0; i < 25_000; i++) {
    // Uneven pattern so each tab sometimes ticks several times in a row.
    const tab = i % 7 < 4 ? firstTab : secondTab;
    if (i % 50 === 0) {
      wallTime++;
    }

    if (shareState && shared) {
      tab.observe(shared);
    }
    const t = tab.tick();
    if (shareState) {
      tab.observe(t);
      shared = t;
    }
    issued.push(t);
  }

  return issued;
};

describe("HybridLogicalClock", () => {
  describe("constructor", () => {
    const cases = [
      {
        name: "starts at zero without a last timestamp",
        last: null,
        expected: { physical: 0, logical: 0 },
      },
      {
        name: "restores from a last timestamp",
        last: ts(5000, 7),
        expected: { physical: 5000, logical: 7 },
      },
      {
        name: "restores from a last timestamp issued by another node",
        last: ts(5000, 7, "other"),
        expected: { physical: 5000, logical: 7 },
      },
      {
        name: "restores a last timestamp with an exhausted counter",
        last: ts(5000, MAX_LOGICAL),
        expected: { physical: 5000, logical: MAX_LOGICAL },
      },
    ];

    it.each(cases)("$name", ({ last, expected }) => {
      const { clock } = createClock({ last });

      expect(clock.nodeId).toBe(NODE);
      expectTimestamp(clock.last(), expected.physical, expected.logical);
    });

    const invalidCases = [
      { name: "empty nodeId", nodeId: "", maxDriftMs: undefined },
      {
        name: "invalid nodeId characters",
        nodeId: "a.b",
        maxDriftMs: undefined,
      },
      { name: "negative maxDriftMs", nodeId: NODE, maxDriftMs: -1 },
      { name: "NaN maxDriftMs", nodeId: NODE, maxDriftMs: Number.NaN },
    ];

    it.each(invalidCases)("rejects $name", ({ nodeId, maxDriftMs }) => {
      expect(() => createClock({ nodeId, maxDriftMs })).toThrow(RangeError);
    });

    it("accepts Infinity maxDriftMs", () => {
      expect(() => createClock({ maxDriftMs: Infinity })).not.toThrow();
    });

    it("works without an options object", () => {
      const before = Date.now();
      const clock = new HybridLogicalClock(NODE);

      expectTimestamp(clock.last(), 0, 0);
      expect(clock.tick().physicalTime).toBeGreaterThanOrEqual(before);
    });
  });

  describe("tick", () => {
    const cases = [
      {
        name: "wall time ahead of state uses wall time and resets counter",
        last: ts(1000, 5),
        time: 2000,
        expected: { physical: 2000, logical: 0 },
      },
      {
        name: "wall time equal to state increments counter",
        last: ts(1000, 5),
        time: 1000,
        expected: { physical: 1000, logical: 6 },
      },
      {
        name: "wall time behind state increments counter",
        last: ts(1000, 5),
        time: 500,
        expected: { physical: 1000, logical: 6 },
      },
      {
        name: "fresh clock uses wall time",
        last: null,
        time: 1000,
        expected: { physical: 1000, logical: 0 },
      },
      {
        name: "exhausted counter steps physical time and resets counter",
        last: ts(1000, MAX_LOGICAL),
        time: 1000,
        expected: { physical: 1001, logical: 0 },
      },
      {
        name: "exhausted counter is irrelevant when wall time advances",
        last: ts(1000, MAX_LOGICAL),
        time: 1005,
        expected: { physical: 1005, logical: 0 },
      },
    ];

    it.each(cases)("$name", ({ last, time, expected }) => {
      const { clock } = createClock({ last, time });

      const result = clock.tick();

      expectTimestamp(result, expected.physical, expected.logical);
      expectTimestamp(clock.last(), expected.physical, expected.logical);
    });

    it("rejects a non-integer wall time and leaves state unchanged", () => {
      const { clock } = createClock({ last: ts(900, 4), time: 1000.5 });

      expect(() => clock.tick()).toThrow(RangeError);
      expectTimestamp(clock.last(), 900, 4);
    });
  });

  describe("receive", () => {
    const cases = [
      {
        name: "wall time ahead of local and remote uses wall time and resets counter",
        last: ts(1000, 5),
        time: 3000,
        remote: ts(2000, 9, REMOTE),
        expected: { physical: 3000, logical: 0 },
      },
      {
        name: "remote behind local increments local counter and keeps physical time",
        last: ts(2000, 5),
        time: 1000,
        remote: ts(1500, 9, REMOTE),
        expected: { physical: 2000, logical: 6 },
      },
      {
        name: "remote ahead of local adopts remote time and increments remote counter",
        last: ts(1000, 5),
        time: 1000,
        remote: ts(2000, 3, REMOTE),
        expected: { physical: 2000, logical: 4 },
      },
      {
        name: "physical tie with higher local counter increments local counter",
        last: ts(2000, 8),
        time: 1000,
        remote: ts(2000, 3, REMOTE),
        expected: { physical: 2000, logical: 9 },
      },
      {
        name: "physical tie with higher remote counter increments remote counter",
        last: ts(2000, 3),
        time: 1000,
        remote: ts(2000, 8, REMOTE),
        expected: { physical: 2000, logical: 9 },
      },
      {
        name: "local, remote and wall time all tied increments the highest counter",
        last: ts(2000, 3),
        time: 2000,
        remote: ts(2000, 8, REMOTE),
        expected: { physical: 2000, logical: 9 },
      },
      {
        name: "remote with exhausted counter steps physical time",
        last: ts(1000, 0),
        time: 1000,
        remote: ts(2000, MAX_LOGICAL, REMOTE),
        expected: { physical: 2001, logical: 0 },
      },
      {
        name: "local with exhausted counter steps physical time",
        last: ts(2000, MAX_LOGICAL),
        time: 1000,
        remote: ts(1000, 0, REMOTE),
        expected: { physical: 2001, logical: 0 },
      },
      {
        name: "remote exactly at the drift limit is accepted",
        last: null,
        time: 1000,
        remote: ts(1000 + DEFAULT_MAX_DRIFT_MS, 0, REMOTE),
        expected: { physical: 1000 + DEFAULT_MAX_DRIFT_MS, logical: 1 },
      },
    ];

    it.each(cases)("$name", ({ last, time, remote, expected }) => {
      const { clock } = createClock({ last, time });

      const result = clock.receive(remote);

      expectTimestamp(result, expected.physical, expected.logical);
      expectTimestamp(clock.last(), expected.physical, expected.logical);
    });

    const driftCases = [
      {
        name: "remote just beyond the default drift limit",
        maxDriftMs: undefined,
        remote: ts(1000 + DEFAULT_MAX_DRIFT_MS + 1, 0, REMOTE),
      },
      {
        name: "remote far beyond the default drift limit",
        maxDriftMs: undefined,
        remote: ts(1000 + 10 * DEFAULT_MAX_DRIFT_MS, 0, REMOTE),
      },
      {
        name: "remote beyond a custom drift limit",
        maxDriftMs: 100,
        remote: ts(1101, 0, REMOTE),
      },
      {
        name: "any future remote with zero drift allowed",
        maxDriftMs: 0,
        remote: ts(1001, 0, REMOTE),
      },
    ];

    it.each(driftCases)(
      "throws ClockDriftError and leaves state unchanged for $name",
      ({ maxDriftMs, remote }) => {
        const { clock } = createClock({
          last: ts(900, 4),
          time: 1000,
          maxDriftMs,
        });

        expect(() => clock.receive(remote)).toThrow(ClockDriftError);
        expectTimestamp(clock.last(), 900, 4);
      },
    );

    it("skips the drift check when maxDriftMs is Infinity", () => {
      const { clock } = createClock({ time: 1000, maxDriftMs: Infinity });
      const remotePhysical = 1000 + 1000 * DEFAULT_MAX_DRIFT_MS;

      const result = clock.receive(ts(remotePhysical, 0, REMOTE));

      expectTimestamp(result, remotePhysical, 1);
    });
  });

  describe("observe", () => {
    const cases = [
      {
        name: "older physical time is ignored",
        last: ts(2000, 5),
        other: ts(1000, 9, REMOTE),
        expected: { physical: 2000, logical: 5 },
      },
      {
        name: "same physical time with lower counter is ignored",
        last: ts(2000, 5),
        other: ts(2000, 4, REMOTE),
        expected: { physical: 2000, logical: 5 },
      },
      {
        name: "identical time is ignored",
        last: ts(2000, 5),
        other: ts(2000, 5, REMOTE),
        expected: { physical: 2000, logical: 5 },
      },
      {
        name: "same physical time with higher counter is adopted without incrementing",
        last: ts(2000, 5),
        other: ts(2000, 6, REMOTE),
        expected: { physical: 2000, logical: 6 },
      },
      {
        name: "newer physical time is adopted without incrementing",
        last: ts(2000, 5),
        other: ts(3000, 0, REMOTE),
        expected: { physical: 3000, logical: 0 },
      },
      {
        name: "newer physical time with lower counter is adopted as is",
        last: ts(2000, 5),
        other: ts(3000, 2, REMOTE),
        expected: { physical: 3000, logical: 2 },
      },
    ];

    it.each(cases)("$name", ({ last, other, expected }) => {
      const { clock } = createClock({ last });

      clock.observe(other);

      expectTimestamp(clock.last(), expected.physical, expected.logical);
    });

    it("does not consult wall time", () => {
      let calls = 0;
      const clock = new HybridLogicalClock(NODE, {
        now: () => {
          calls++;
          return 1000;
        },
      });

      clock.observe(ts(5000, 0, REMOTE));

      expect(calls).toBe(0);
    });
  });

  describe("toString", () => {
    const cases = [
      {
        name: "fresh clock",
        last: null,
        expected: "000000000000000.0000.local",
      },
      {
        name: "restored clock",
        last: ts(1_700_000_000_000, 42),
        expected: "001700000000000.0042.local",
      },
      {
        name: "restored from another node uses own nodeId",
        last: ts(5000, 1, "other"),
        expected: "000000000005000.0001.local",
      },
    ];

    it.each(cases)("serializes $name", ({ last, expected }) => {
      const { clock } = createClock({ last });

      expect(clock.toString()).toBe(expected);
    });
  });

  describe("scenarios", () => {
    it("tick increases while time advances", () => {
      const { clock, setTime } = createClock({ time: 1000 });

      const first = clock.tick();
      setTime(1001);
      const second = clock.tick();

      expectGreater(second, first);
      expectTimestamp(second, 1001, 0);
    });

    it("tick increases 10,001 times while time is frozen, stepping physical time on overflow", () => {
      const { clock } = createClock({ time: 1000 });

      const ticks = Array.from({ length: 10_001 }, () => clock.tick());

      expectIncreasing(ticks);
      expectTimestamp(elementAt(ticks, 0), 1000, 0);
      expectTimestamp(elementAt(ticks, 9_999), 1000, MAX_LOGICAL);
      expectTimestamp(elementAt(ticks, 10_000), 1001, 0);
    });

    it("tick stays ahead of a restored last timestamp when wall time goes backwards", () => {
      const last = ts(5000, 3);
      const { clock } = createClock({ last, time: 1000 });

      expectGreater(clock.tick(), last);
    });

    it("tick after receiving a remote timestamp ahead of local time is greater than the remote", () => {
      const remote = ts(2000, 5, REMOTE);
      const { clock } = createClock({ time: 1000 });

      clock.tick();
      clock.receive(remote);

      expectGreater(clock.tick(), remote);
    });

    it("clock keeps working normally after a rejected drifting remote", () => {
      const { clock, setTime } = createClock({ time: 1000 });
      clock.tick();

      expect(() => clock.receive(ts(1000 + DEFAULT_MAX_DRIFT_MS + 1, 0, REMOTE))).toThrow(
        ClockDriftError,
      );
      setTime(1001);

      expectTimestamp(clock.tick(), 1001, 0);
    });

    describe("two tabs sharing a nodeId", () => {
      it("never issue the same timestamp when observing shared state around every tick", () => {
        const issued = runTabs(true);

        const unique = new Set(issued.map((t) => t.toString()));
        expect(unique.size).toBe(issued.length);
        expectIncreasing(issued);
      });

      it("do issue duplicate timestamps without sharing state (control)", () => {
        const issued = runTabs(false);

        const unique = new Set(issued.map((t) => t.toString()));
        expect(unique.size).toBeLessThan(issued.length);
      });
    });
  });
});
