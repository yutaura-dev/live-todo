import { useState } from "react";
import { writeRequests, writeTroubles } from "../fixtures.js";
import { Approvals } from "./Approvals.js";
import type { View } from "./AppFrame.js";
import { Board } from "./Board.js";
import { Horizon } from "./Horizon.js";
import { Settings } from "./Settings.js";
import { Proposals } from "./Proposals.js";

/** 画面をつないで、左のレールで行き来できるようにしたもの。朝の流れ（承認 → 提案 → 見通し）を通しで試す */
export function Prototype({ start = "見通し" }: { start?: View }) {
  const [view, setView] = useState<View>(start);
  const [writeSelect, setWriteSelect] = useState<{ kind: "頼む" | "困った"; id: number } | null>(null);
  const navigate = (next: View) => {
    setWriteSelect(null);
    setView(next);
  };
  if (view === "提案") return <Proposals onNavigate={navigate} />;
  if (view === "承認") return <Approvals key={writeSelect ? `${writeSelect.kind}-${writeSelect.id}` : "list"} onNavigate={navigate} {...(writeSelect ? { select: writeSelect } : {})} />;
  if (view === "カンバン") return <Board onNavigate={navigate} />;
  if (view === "設定") return <Settings onNavigate={navigate} />;
  return (
    <Horizon
      onNavigate={navigate}
      onOpenWrite={(taskId) => {
        const trouble = writeTroubles.find((candidate) => candidate.taskId === taskId);
        const request = writeRequests.find((candidate) => candidate.taskId === taskId);
        setWriteSelect(trouble ? { kind: "困った", id: trouble.id } : request ? { kind: "頼む", id: request.id } : null);
        setView("承認");
      }}
    />
  );
}
