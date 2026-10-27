// Settings › Voice: hands-free settings, the same fields as the sheet in the hands-free dock.
import { useEffect } from "react";
import { useHandsFree } from "../../voice/HandsFreeProvider";
import { HandsFreeSettingsFields } from "../../voice/VoiceSettingsSheet";
import { SettingsSection } from "./SettingsSection";

export function HandsFreeSettingsSection() {
  const handsFree = useHandsFree();
  const { refreshStatus } = handsFree;
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  return <SettingsSection title="Hands-free" description="Shared by every chat and Tether.">
    <div className="max-w-md"><HandsFreeSettingsFields controller={handsFree} /></div>
  </SettingsSection>;
}
