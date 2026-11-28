import { Button } from "../../design/components.js";
import type { EffectView } from "../shared/api.js";

const DELIVERY_LABELS = { まだ: null, 頼んだ: "書き込んでいます", 書き込んだ: "書き込みました", 書き込めなかった: "書き込めませんでした", 取りやめた: "取りやめました" } as const;

/**
 * 完了待ちのチェックリスト。☑ が付いているものを、完了のボタンで書き込む（押したことが承認。charter）。
 * AI が足したものも初めから ☑ なので、押す前に何を書き込むかを並べて見せる。
 */
export function CompletionChecklist(props: {
  effects: ReadonlyArray<EffectView>;
  onAction: (effectId: string, action: "check" | "uncheck" | "retry") => void;
  onConfirm: () => void;
}) {
  const movable = (effect: EffectView) => effect.delivery === "まだ" || effect.delivery === "書き込めなかった";
  const pending = props.effects.some((effect) => effect.checked && effect.delivery === "まだ");
  return (
    <section className="ui-section" aria-labelledby="effects-title">
      <h3 id="effects-title" className="ui-section-title">
        完了したときにすること
      </h3>
      <p className="ui-sub">☑ が付いているものを、完了にするときに書き込みます。書き込まないものは ☑ を外してください</p>
      <ul className="ui-stack-4">
        {props.effects.map((effect) => (
          <li key={effect.id} className="ui-row">
            <label className="ui-row">
              <input
                type="checkbox"
                checked={effect.checked}
                disabled={!movable(effect)}
                onChange={() => props.onAction(effect.id, effect.checked ? "uncheck" : "check")}
              />
              <span className="ui-stack-4">
                <span>{effect.title}</span>
                <span className="ui-sub">
                  {effect.operation}: {effect.target}
                </span>
              </span>
            </label>
            {DELIVERY_LABELS[effect.delivery] && <span className={effect.delivery === "書き込めなかった" ? "ui-problem" : "ui-sub"}>{DELIVERY_LABELS[effect.delivery]}</span>}
            {effect.delivery === "書き込めなかった" && effect.checked && (
              <Button size="sm" onClick={() => props.onAction(effect.id, "retry")}>
                もう一度頼む
              </Button>
            )}
          </li>
        ))}
      </ul>
      {pending && (
        <Button tone="primary" size="sm" className="ui-self-start" onClick={props.onConfirm}>
          確かめて完了にする
        </Button>
      )}
    </section>
  );
}
