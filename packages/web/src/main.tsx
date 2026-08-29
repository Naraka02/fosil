import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

document.documentElement.dataset.app = "fosil";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
