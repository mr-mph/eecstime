import { Container, Flex } from "@repo/theme";

import styles from "./Organization.module.scss";

export default function Organization() {
  return (
    <Flex direction="column" className={styles.root} pt="9">
      <Container className={styles.aboutSection}>
        <div className={styles.aboutContent}>
          <h2 className={styles.aboutTitle}>About EECStime</h2>
          <p className={styles.aboutText}>
            <a
              href="https://eecstime.sethw.dev"
              className={styles.inlineLink}
            >
              EECStime
            </a>{" "}
            is a modified version of Berkeleytime that improves course
            discovery, enrollment planning, scheduling, and more.
          </p>
        </div>
      </Container>
    </Flex>
  );
}
