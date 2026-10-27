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
  return <SettingsSection title="Hands-free" description="Talk to any chat and hear its replies. One set of settings for every chat, shared with Tether.">
    <div className="max-w-md"><HandsFreeSettingsFields controller={handsFree} /></div>
  </SettingsSection>;
}
