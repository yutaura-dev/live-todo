import { describe, expect, it } from "vitest";
import { diffSnapshot } from "./snapshot-differ.js";

type Fixture = { id: string; body: string };

const identify = (item: Fixture) => ({ externalId: item.id, fingerprint: item.body });

describe("diffSnapshot", () => {
  it("前回のスナップショットにない項目は upserted として返す", () => {
    const previous = new Map<string, string>();
    const current = [{ id: "a", body: "v1" }];

    const { changes } = diffSnapshot(previous, current, identify);

    expect(changes).toEqual([{ kind: "upserted", item: { id: "a", body: "v1" } }]);
  });

  it("fingerprint が変わった項目は upserted として返す", () => {
    const previous = new Map([["a", "v1"]]);
    const current = [{ id: "a", body: "v2" }];

    const { changes } = diffSnapshot(previous, current, identify);

    expect(changes).toEqual([{ kind: "upserted", item: { id: "a", body: "v2" } }]);
  });

  it("fingerprint が変わっていない項目は変更として返さない", () => {
    const previous = new Map([["a", "v1"]]);
    const current = [{ id: "a", body: "v1" }];

    const { changes } = diffSnapshot(previous, current, identify);

    expect(changes).toEqual([]);
  });

  it("今回のスナップショットから消えた項目は removed として返す", () => {
    const previous = new Map([["a", "v1"]]);
    const current: Fixture[] = [];

    const { changes } = diffSnapshot(previous, current, identify);

    expect(changes).toEqual([{ kind: "removed", externalId: "a" }]);
  });

  it("次回の比較に使う fingerprint の一覧を今回のスナップショットから作る", () => {
    const previous = new Map([["a", "v1"], ["gone", "x"]]);
    const current = [{ id: "a", body: "v2" }, { id: "b", body: "v1" }];

    const { nextFingerprints } = diffSnapshot(previous, current, identify);

    expect(nextFingerprints).toEqual(new Map([["a", "v2"], ["b", "v1"]]));
  });

  it("同じ externalId が今回のスナップショットに重複していたらエラーにする", () => {
    const previous = new Map<string, string>();
    const current = [{ id: "a", body: "v1" }, { id: "a", body: "v2" }];

    expect(() => diffSnapshot(previous, current, identify)).toThrow("externalId が重複しています: a");
  });
});
