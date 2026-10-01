import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/literata/600.css";
import "../app/globals.css";
import { KitchenScreen } from "../components/KitchenScreen";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <KitchenScreen />
  </React.StrictMode>,
);
