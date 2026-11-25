import { useRef, useState, type KeyboardEvent } from "react";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export type FieldEdit = {
  begin: () => void;
  end: (commit: boolean) => void;
  normalize?: (text: string) => string | undefined;
};

export function FieldEditor({ id, label, value, multiline, rows, onChange, edit }: {
  id?: string;
  label: string;
  value: string;
  multiline: boolean;
  rows?: number;
  onChange: (value: string) => void;
  edit: FieldEdit;
}) {
  const [draft, setDraft] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const field = useRef<FieldElement | null>(null);
  const active = useRef(false);
  const composing = useRef(false);
  const normalize = (text: string) => edit.normalize ? edit.normalize(text) : text;

  const preview = (text: string) => {
    setDraft(text);
    const next = normalize(text);
    if (next !== undefined) {
      setInvalid(false);
      if (next !== value) onChange(next);
    }
  };

  const finish = (element: FieldElement, explicit: boolean) => {
    if (!active.current || (explicit && composing.current)) return;
    const next = draft !== undefined && !composing.current ? normalize(element.value) : value;
    if (draft !== undefined && next === undefined) {
      setInvalid(true);
      if (explicit) return;
    } else {
      if (next !== undefined && next !== value) onChange(next);
      setDraft(undefined);
      setInvalid(false);
    }
    active.current = false;
    composing.current = false;
    edit.end(true);
    if (explicit) element.blur();
  };

  const onKeyDown = (event: KeyboardEvent<FieldElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && active.current) {
      event.preventDefault();
      event.stopPropagation();
      active.current = false;
      setDraft(undefined);
      setInvalid(false);
      edit.end(false);
      event.currentTarget.blur();
    }
    if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      finish(event.currentTarget, true);
    }
  };

  const props = {
    id,
    "aria-label": label,
    "aria-invalid": invalid || undefined,
    "data-field-edit": "",
    value: draft ?? value,
    onFocus: () => {
      if (active.current) return;
      active.current = true;
      edit.begin();
    },
    onBlur: (event: React.FocusEvent<FieldElement>) => finish(event.currentTarget, false),
    onChange: (event: React.ChangeEvent<FieldElement>) => {
      if (composing.current) setDraft(event.currentTarget.value);
      else if (active.current) preview(event.currentTarget.value);
      else {
        const next = normalize(event.currentTarget.value);
        if (next !== undefined) onChange(next);
      }
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<FieldElement>) => {
      composing.current = false;
      if (active.current) preview(event.currentTarget.value);
    },
    onKeyDown,
  };
  return <>
    {multiline
      ? <textarea {...props} ref={(element) => { field.current = element; }} className="ctrl-input ctrl-textarea" rows={rows} />
      : <input {...props} ref={(element) => { field.current = element; }} className="ctrl-input" type="text" />}
    {invalid && <small className="ctrl-hint" role="alert">请输入完整数字。</small>}
    {draft !== undefined && <button type="button" tabIndex={-1} className="video-btn"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!field.current) return;
        if (active.current) finish(field.current, true);
        else field.current.focus();
      }}>完成</button>}
  </>;
}
