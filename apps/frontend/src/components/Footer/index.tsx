import { HalfMoon, MacOsWindow, SunLight } from "iconoir-react";

import { Container, PillSwitcher, useTheme } from "@repo/theme";

import styles from "./Footer.module.scss";

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  const items = [
    { value: "system", label: <MacOsWindow width={14} height={14} /> },
    { value: "light", label: <SunLight width={14} height={14} /> },
    { value: "dark", label: <HalfMoon width={14} height={14} /> },
  ];

  return (
    <PillSwitcher
      items={items}
      value={theme ?? "system"}
      onValueChange={(value) =>
        setTheme(value === "system" ? null : (value as "light" | "dark"))
      }
      iconOnly
    />
  );
}

export default function Footer() {
  return (
    <Container className={styles.wrapper}>
      <div className={styles.bottom}>
        <span>© {new Date().getFullYear()}, EECStime.</span>
        <ThemeSwitcher />
      </div>
    </Container>
  );
}
