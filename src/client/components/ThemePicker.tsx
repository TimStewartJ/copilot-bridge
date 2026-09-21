import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemePreference } from "../api";
import { SegmentedControl } from "../design/primitives";

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

interface Props {
  value: ThemePreference;
  onChange: (t: ThemePreference) => void;
}

export default function ThemePicker({ value, onChange }: Props) {
  return (
    <SegmentedControl
      ariaLabel="Theme"
      value={value}
      onChange={onChange}
      onReselect={onChange}
      options={OPTIONS.map(({ value: option, label, Icon }) => ({ value: option, label, title: label, icon: <Icon size={14} /> }))}
    />
  );
}
