import { useId, useState } from "react";
import { isRepositoryPattern, type RepositoryChoices, suggestPatterns } from "./repository-picker.js";

export function RepositoryPicker(props: {
  label: string;
  hint: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  choices: RepositoryChoices;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const suggestions = suggestPatterns(props.choices, query, props.value);

  const add = (pattern: string) => {
    props.onChange([...props.value, pattern]);
    setQuery("");
  };
  const remove = (pattern: string) => props.onChange(props.value.filter((selected) => selected !== pattern));

  return (
    <div className="picker">
      <label className="field" htmlFor={id}>
        <span className="field-label">{props.label}</span>
        <span className="field-hint">{props.hint}</span>
      </label>
      <div className="picker-box">
        {props.value.map((pattern) => (
          <span key={pattern} className="chip">
            {pattern}
            <button type="button" className="chip-remove" aria-label={`${pattern} を外す`} onClick={() => remove(pattern)}>
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="picker-input"
          value={query}
          placeholder={props.value.length === 0 ? "リポジトリや org を検索" : ""}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={`${id}-list`}
          onFocus={() => setOpen(true)}
          // 候補をクリックする前に閉じないよう、少し待ってから閉じる
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const first = suggestions[0];
              if (first !== undefined) add(first);
            } else if (event.key === "Backspace" && query === "" && props.value.length > 0) {
              remove(props.value[props.value.length - 1]!);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul id={`${id}-list`} className="picker-list" role="listbox">
          {suggestions.map((pattern) => (
            <li key={pattern} role="option" aria-selected={false}>
              <button type="button" className="picker-option" onMouseDown={(event) => event.preventDefault()} onClick={() => add(pattern)}>
                <span>{pattern}</span>
                {pattern.endsWith("/*") && <span className="field-hint">{pattern.slice(0, -2)} のすべて</span>}
                {!pattern.endsWith("/*") && isRepositoryPattern(pattern) && !props.choices.repositories.includes(pattern) && (
                  <span className="field-hint">一覧にないが追加する</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
