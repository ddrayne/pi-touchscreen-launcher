import React from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import { Launcher } from "../components/Launcher";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Launcher />
  </React.StrictMode>,
);
