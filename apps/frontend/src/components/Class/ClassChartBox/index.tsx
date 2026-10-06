import type { ReactNode } from "react";

import classNames from "classnames";
import { ArrowUpRight } from "iconoir-react";

import { Box, Button, Container, LoadingIndicator } from "@repo/theme";

import styles from "./ClassChartBox.module.scss";

interface ClassChartBoxProps {
  title: string;
  subtitle?: string | null;
  actionLabel: string;
  actionHref: string;
  showActionWhenEmpty?: boolean;
  loading?: boolean;
  emptyState?: {
    icon: ReactNode;
    heading: string;
    paragraph: ReactNode;
  };
  children: ReactNode;
}

export default function ClassChartBox({
  title,
  subtitle,
  actionLabel,
  actionHref,
  showActionWhenEmpty = false,
  loading,
  emptyState,
  children,
}: ClassChartBoxProps) {
  const action = (
    <Button
      as="a"
      href={actionHref}
      target="_blank"
      rel="noreferrer noopener"
      variant="secondary"
      className={classNames(styles.openButton, {
        [styles.emptyAction]: Boolean(emptyState),
      })}
    >
      {actionLabel}
      <ArrowUpRight height={16} width={16} />
    </Button>
  );

  if (loading) {
    return (
      <Box p="5" className={styles.root}>
        <Container size="3">
          <div className={styles.wrapper}>
            <div className={styles.emptyInBox}>
              <LoadingIndicator size="lg" />
            </div>
          </div>
        </Container>
      </Box>
    );
  }

  if (emptyState) {
    return (
      <Box p="5" className={styles.root}>
        <Container size="3">
          <div className={styles.wrapper}>
            <div className={styles.emptyInBox}>
              <div className={styles.emptyIcon}>{emptyState.icon}</div>
              <p className={styles.emptyHeading}>{emptyState.heading}</p>
              <p className={styles.emptyParagraph}>{emptyState.paragraph}</p>
              {showActionWhenEmpty && action}
            </div>
          </div>
        </Container>
      </Box>
    );
  }

  return (
    <Box p="5" className={styles.root}>
      <Container size="3">
        <div className={styles.wrapper}>
          <div className={styles.header}>
            <div className={styles.titleBlock}>
              <h2 className={styles.title}>{title}</h2>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            {action}
          </div>
          {children}
        </div>
      </Container>
    </Box>
  );
}
