import type { Metadata } from "next";
import { KitchenScreen } from "../components/KitchenScreen";

export const metadata: Metadata = {
  title: "Kitchen Screen",
  description: "The garden's birds, timers, rain and the kitchen speaker on the Pi touchscreen.",
};

export default function Home() {
  return <KitchenScreen />;
}
