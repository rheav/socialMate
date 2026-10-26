import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import React from "react";
import { createRoot } from "react-dom/client";

import { DashboardApp } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* `reducedMotion="user"` neutralises transform and layout animation for anyone whose OS asks for less motion. */}
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <DashboardApp />
      </LazyMotion>
    </MotionConfig>
  </React.StrictMode>,
);
