import type { Metadata } from "next";
import { Launcher } from "../components/Launcher";

export const metadata: Metadata = {
  title: "Touchscreen Assistant",
  description: "The voice-first home screen for the Raspberry Pi touchscreen.",
};

export default function Home() {
  return <Launcher />;
}
