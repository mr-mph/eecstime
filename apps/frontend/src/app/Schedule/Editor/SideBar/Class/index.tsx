import { useCallback, useMemo, useState } from "react";

import {
  CompressLines,
  EditPencil,
  Eye,
  EyeClosed,
  Lock,
  LockSlash,
  Trash,
} from "iconoir-react";

import { Tooltip } from "@repo/theme";

import { acceptedColors } from "@/app/Schedule/schedule";
import { ActionMenu } from "@/components/ActionMenu";
import { MenuItem } from "@/components/BubbleCard";
import ClassCard from "@/components/ClassCard";
import ClassDrawer from "@/components/ClassDrawer";
import { ColorDot } from "@/components/ColorDot";
import { IScheduleClass, componentMap } from "@/lib/api";
import { capitalizeColor } from "@/lib/colors";
import { ResolvedFinalExam } from "@/lib/finalExam";
import { Color, Component, Semester } from "@/lib/generated/graphql";

import styles from "./Class.module.scss";
import FinalExamChip from "./FinalExamChip";
import Section from "./Section";
import TimeSlotGroup, {
  groupSectionsByMeetingTime,
} from "./TimeSlotGroup";

interface ClassProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  editing: boolean;
  class: IScheduleClass["class"];
  semester: Semester;
  year: number;
  sessionId: string;
  color: Color;
  hidden?: boolean;
  locked?: boolean;
  blockedSections?: IScheduleClass["blockedSections"];
  lockedComponents?: Component[];
  selectedSections: IScheduleClass["selectedSections"];
  finalExam?: ResolvedFinalExam | null;
  finalExamConflicts?: string[];
  onSectionSelect: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    number: string
  ) => void;
  onSiblingLectureSelect: (
    subject: string,
    courseNumber: string,
    fromClassNumber: string,
    toClassNumber: string
  ) => void;
  onSectionMouseOver: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    number: string
  ) => void;
  onSectionMouseOut: () => void;
  onDelete: (cls: IScheduleClass["class"]) => void;
  onColorChange: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    color: Color
  ) => void;
  onLockChange: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    locked: boolean
  ) => void;
  onHideChange: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    hidden: boolean
  ) => void;
  onSectionBlockToggle: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    sectionId: number,
    blocked: boolean
  ) => void;
  onComponentBlockToggle: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    component: Component,
    blocked: boolean
  ) => void;
  onComponentLockChange: (
    subject: string,
    courseNumber: string,
    classNumber: string,
    component: Component,
    locked: boolean
  ) => void;
}

export default function Class({
  expanded,
  onExpandedChange,
  editing,
  class: _class,
  semester,
  year,
  sessionId,
  color,
  hidden = false,
  locked = false,
  blockedSections = [],
  lockedComponents = [],
  selectedSections,
  finalExam = null,
  finalExamConflicts = [],
  onSectionSelect,
  onSiblingLectureSelect,
  onSectionMouseOver,
  onSectionMouseOut,
  onDelete,
  onColorChange,
  onLockChange,
  onHideChange,
  onSectionBlockToggle,
  onComponentBlockToggle,
  onComponentLockChange,
}: ClassProps) {
  const groups = useMemo(() => {
    const sortedSections = _class.sections.toSorted((a, b) => {
      if (a.number === "999") return -1;
      if (b.number === "999") return 1;
      return a.number.localeCompare(b.number, undefined, { numeric: true });
    });

    return Object.groupBy(sortedSections, (section) => section.component);
  }, [_class]);

  // Primary section plus sibling lectures from other class listings (e.g. 001 + 002)
  const primarySections = useMemo(() => {
    if (!_class.primarySection) return [];
    const siblings = _class.siblingPrimarySections ?? [];
    return [_class.primarySection, ...siblings].toSorted((a, b) => {
      if (a.number === "999") return -1;
      if (b.number === "999") return 1;
      return a.number.localeCompare(b.number, undefined, { numeric: true });
    });
  }, [_class.primarySection, _class.siblingPrimarySections]);

  // Helper to count sections for a component (including primary + sibling lectures)
  const getSectionCountForComponent = useCallback(
    (component: Component) => {
      const sectionsInGroup = groups[component] || [];
      const primaryMatches =
        _class.primarySection?.component === component ? 1 : 0;
      const siblingMatches =
        _class.primarySection?.component === component
          ? (_class.siblingPrimarySections?.length ?? 0)
          : 0;
      return sectionsInGroup.length + primaryMatches + siblingMatches;
    },
    [groups, _class.primarySection, _class.siblingPrimarySections]
  );

  // Helper to get all section IDs for a component
  const getSectionIdsForComponent = useCallback(
    (component: Component): number[] => {
      const sectionsInGroup = groups[component] || [];
      const sectionIds: number[] = [];

      // Add section IDs from grouped sections
      sectionsInGroup.forEach((section) => {
        if (section?.sectionId) {
          sectionIds.push(section.sectionId);
        }
      });

      // Add primary section if it matches the component
      if (
        _class.primarySection?.component === component &&
        _class.primarySection?.sectionId
      ) {
        sectionIds.push(_class.primarySection.sectionId);
      }

      // Include sibling lectures so exclude-all covers every lecture option
      if (_class.primarySection?.component === component) {
        for (const sibling of _class.siblingPrimarySections ?? []) {
          if (sibling?.sectionId) sectionIds.push(sibling.sectionId);
        }
      }

      return sectionIds;
    },
    [groups, _class.primarySection, _class.siblingPrimarySections]
  );

  // Helper to check if all sections in a component are blocked
  const areAllSectionsBlocked = useCallback(
    (component: Component): boolean => {
      const sectionIds = getSectionIdsForComponent(component);
      if (sectionIds.length === 0) return false;
      return sectionIds.every((sectionId) =>
        blockedSections?.find((s) => s === sectionId)
      );
    },
    [getSectionIdsForComponent, blockedSections]
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [groupByTimeComponents, setGroupByTimeComponents] = useState<
    Set<Component>
  >(() => new Set());

  const toggleGroupByTime = useCallback((component: Component) => {
    setGroupByTimeComponents((prev) => {
      const next = new Set(prev);
      if (next.has(component)) next.delete(component);
      else next.add(component);
      return next;
    });
  }, []);

  const handlePrimarySectionSelect = useCallback(
    (sectionNumber: string) => {
      if (sectionNumber === _class.number) {
        onSectionSelect(
          _class.subject,
          _class.courseNumber,
          _class.number,
          sectionNumber
        );
        return;
      }
      onSiblingLectureSelect(
        _class.subject,
        _class.courseNumber,
        _class.number,
        sectionNumber
      );
    },
    [
      _class.subject,
      _class.courseNumber,
      _class.number,
      onSectionSelect,
      onSiblingLectureSelect,
    ]
  );

  // Color submenu
  const colorSubItems: MenuItem[] = acceptedColors.map((c) => ({
    name: capitalizeColor(c),
    icon: <ColorDot color={c} />,
    onClick: () =>
      onColorChange(_class.subject, _class.courseNumber, _class.number, c),
  }));

  const menuItems: MenuItem[] = [
    {
      name: "Edit color",
      icon: <EditPencil width={18} height={18} />,
      subItems: colorSubItems,
    },
    {
      name: locked ? "Unlock class" : "Lock class",
      icon: <Lock width={18} height={18} />,
      onClick: () =>
        onLockChange(
          _class.subject,
          _class.courseNumber,
          _class.number,
          !locked
        ),
    },
    {
      name: hidden ? "Show class" : "Hide class",
      icon: hidden ? (
        <Eye width={18} height={18} />
      ) : (
        <EyeClosed width={18} height={18} />
      ),
      onClick: () =>
        onHideChange(
          _class.subject,
          _class.courseNumber,
          _class.number,
          !hidden
        ),
    },
    {
      name: "Delete class",
      icon: <Trash width={18} height={18} />,
      onClick: () => onDelete(_class),
      isDelete: true,
    },
  ];

  return (
    <ClassDrawer
      subject={_class.subject}
      number={_class.number}
      courseNumber={_class.courseNumber}
      year={year}
      semester={semester}
      sessionId={sessionId}
      open={drawerOpen}
      onOpenChange={setDrawerOpen}
    >
      <div
        onClick={(e) => {
          // Only open drawer if not clicking on action areas
          // Action buttons have stopPropagation, so they won't trigger this
          const target = e.target as HTMLElement;
          if (
            target.closest("[data-action-icon]") ||
            target.closest("[data-actions]") ||
            target.closest("[data-color-selector]") ||
            target.closest("[data-action-menu]")
          ) {
            return;
          }
          setDrawerOpen(true);
        }}
        style={{ cursor: "pointer" }}
      >
        <ClassCard
          data-draggable
          class={_class}
          expandable
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          leftBorderColor={hidden ? undefined : color}
          customActionMenu={
            editing ? <ActionMenu menuItems={menuItems} asIcon /> : undefined
          }
          infoContent={
            finalExam ? (
              <FinalExamChip exam={finalExam} conflicts={finalExamConflicts} />
            ) : undefined
          }
          singleLineInfo
          wrapDescription={true}
          onUnlock={
            locked
              ? () =>
                  onLockChange(
                    _class.subject,
                    _class.courseNumber,
                    _class.number,
                    false
                  )
              : undefined
          }
        >
          <div className={styles.group}>
            <div className={styles.label}>
              {_class.primarySection ? (
                (() => {
                  const primaryComponent = _class.primarySection.component;
                  const primarySectionCount =
                    getSectionCountForComponent(primaryComponent);
                  const groupByTime =
                    groupByTimeComponents.has(primaryComponent);
                  const canGroupByTime = primarySectionCount > 1;
                  return (
                    <>
                      <div className={styles.componentRow}>
                        <p className={styles.component}>
                          {componentMap[primaryComponent]}
                        </p>
                        <div className={styles.componentIcons}>
                          <Tooltip
                            trigger={
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const allBlocked =
                                    areAllSectionsBlocked(primaryComponent);

                                  // Toggle all sections in this component
                                  onComponentBlockToggle(
                                    _class.subject,
                                    _class.courseNumber,
                                    _class.number,
                                    primaryComponent,
                                    !allBlocked
                                  );
                                }}
                                className={styles.iconButton}
                              >
                                {areAllSectionsBlocked(primaryComponent) ? (
                                  <EyeClosed width={16} height={16} />
                                ) : (
                                  <Eye width={16} height={16} />
                                )}
                              </button>
                            }
                            title={
                              areAllSectionsBlocked(primaryComponent)
                                ? "Include All Sections"
                                : "Exclude All Sections"
                            }
                          />
                          {primarySectionCount > 1 && (
                            <Tooltip
                              trigger={
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onComponentLockChange(
                                      _class.subject,
                                      _class.courseNumber,
                                      _class.number,
                                      primaryComponent,
                                      !lockedComponents.includes(
                                        primaryComponent
                                      )
                                    );
                                  }}
                                  className={`${styles.iconButton} ${lockedComponents.includes(primaryComponent) ? styles.locked : ""}`}
                                >
                                  {lockedComponents.includes(
                                    primaryComponent
                                  ) ? (
                                    <Lock width={16} height={16} />
                                  ) : (
                                    <LockSlash width={16} height={16} />
                                  )}
                                </button>
                              }
                              title={
                                lockedComponents.includes(primaryComponent)
                                  ? "Unlock component"
                                  : "Lock component"
                              }
                            />
                          )}
                          {canGroupByTime && (
                            <Tooltip
                              trigger={
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleGroupByTime(primaryComponent);
                                  }}
                                  className={`${styles.iconButton} ${groupByTime ? styles.locked : ""}`}
                                  aria-pressed={groupByTime}
                                >
                                  <CompressLines width={16} height={16} />
                                </button>
                              }
                              title={
                                groupByTime
                                  ? "Show individual sections"
                                  : "Group by time"
                              }
                            />
                          )}
                        </div>
                      </div>
                      <p className={styles.time}>Time</p>
                    </>
                  );
                })()
              ) : (
                <>
                  <p className={styles.component}>N/A</p>
                  <p className={styles.time}>Time</p>
                </>
              )}
            </div>
            {_class.primarySection &&
              (() => {
                const primaryComponent = _class.primarySection.component;
                const groupByTime =
                  groupByTimeComponents.has(primaryComponent);
                const timeGroups = groupByTime
                  ? groupSectionsByMeetingTime(primarySections)
                  : null;

                if (timeGroups) {
                  return timeGroups.map((slotSections) => {
                    if (slotSections.length === 1) {
                      const section = slotSections[0];
                      const active = selectedSections.some(
                        (selectedSection) =>
                          selectedSection.sectionId === section.sectionId
                      );
                      const isBlocked = Boolean(
                        blockedSections?.find((s) => s === section.sectionId)
                      );
                      return (
                        <Section
                          active={active}
                          blocked={isBlocked}
                          editing={editing}
                          onBlockToggle={() => {
                            onSectionBlockToggle(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.sectionId,
                              !isBlocked
                            );
                          }}
                          onSectionMouseOut={onSectionMouseOut}
                          onSectionMouseOver={() =>
                            onSectionMouseOver(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.number
                            )
                          }
                          onSectionSelect={() =>
                            handlePrimarySectionSelect(section.number)
                          }
                          {...section}
                          key={section.sectionId}
                        />
                      );
                    }

                    const selectedInSlot = slotSections.find((section) =>
                      selectedSections.some(
                        (selected) => selected.sectionId === section.sectionId
                      )
                    );
                    return (
                      <TimeSlotGroup
                        key={slotSections
                          .map((section) => section.sectionId)
                          .join("-")}
                        sections={slotSections}
                        selectedSectionId={selectedInSlot?.sectionId ?? null}
                        blockedSectionIds={blockedSections ?? []}
                        editing={editing}
                        onSectionMouseOut={onSectionMouseOut}
                        onSectionMouseOver={(sectionNumber) =>
                          onSectionMouseOver(
                            _class.subject,
                            _class.courseNumber,
                            _class.number,
                            sectionNumber
                          )
                        }
                        onSectionSelect={handlePrimarySectionSelect}
                        onBlockToggle={(blocked) => {
                          for (const section of slotSections) {
                            const currentlyBlocked = Boolean(
                              blockedSections?.find(
                                (s) => s === section.sectionId
                              )
                            );
                            if (currentlyBlocked === blocked) continue;
                            onSectionBlockToggle(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.sectionId,
                              blocked
                            );
                          }
                        }}
                      />
                    );
                  });
                }

                return primarySections.map((section) => {
                  const active = selectedSections.some(
                    (selectedSection) =>
                      selectedSection.sectionId === section.sectionId
                  );
                  const isBlocked = Boolean(
                    blockedSections?.find((s) => s === section.sectionId)
                  );

                  return (
                    <Section
                      active={active}
                      blocked={isBlocked}
                      editing={editing}
                      onBlockToggle={() => {
                        onSectionBlockToggle(
                          _class.subject,
                          _class.courseNumber,
                          _class.number,
                          section.sectionId,
                          !isBlocked
                        );
                      }}
                      {...section}
                      onSectionMouseOver={() =>
                        onSectionMouseOver(
                          _class.subject,
                          _class.courseNumber,
                          _class.number,
                          section.number
                        )
                      }
                      onSectionMouseOut={onSectionMouseOut}
                      onSectionSelect={() =>
                        handlePrimarySectionSelect(section.number)
                      }
                      key={section.sectionId}
                    />
                  );
                });
              })()}
          </div>
          {Object.keys(groups)
            .filter(
              (component) => component !== _class.primarySection?.component
            )
            .map((component) => {
            const group = component as Component;
            const isLocked = lockedComponents.includes(group);
            const sectionCount = getSectionCountForComponent(group);
            const groupByTime = groupByTimeComponents.has(group);
            const canGroupByTime = sectionCount > 1;
            const sectionList = groups[group] ?? [];
            const timeGroups = groupByTime
              ? groupSectionsByMeetingTime(sectionList)
              : null;

            return (
              <div className={styles.group} key={component}>
                <div className={styles.label}>
                  <div className={styles.componentRow}>
                    <p className={styles.component}>{componentMap[group]}</p>
                    <div className={styles.componentIcons}>
                      <Tooltip
                        trigger={
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const allBlocked = areAllSectionsBlocked(group);

                              // Toggle all sections in this component
                              onComponentBlockToggle(
                                _class.subject,
                                _class.courseNumber,
                                _class.number,
                                group,
                                !allBlocked
                              );
                            }}
                            className={styles.iconButton}
                          >
                            {areAllSectionsBlocked(group) ? (
                              <EyeClosed width={16} height={16} />
                            ) : (
                              <Eye width={16} height={16} />
                            )}
                          </button>
                        }
                        title={
                          areAllSectionsBlocked(group)
                            ? "Include All Sections"
                            : "Exclude All Sections"
                        }
                      />
                      {sectionCount > 1 && (
                        <Tooltip
                          trigger={
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onComponentLockChange(
                                  _class.subject,
                                  _class.courseNumber,
                                  _class.number,
                                  group,
                                  !isLocked
                                );
                              }}
                              className={`${styles.iconButton} ${isLocked ? styles.locked : ""}`}
                            >
                              {isLocked ? (
                                <Lock width={16} height={16} />
                              ) : (
                                <LockSlash width={16} height={16} />
                              )}
                            </button>
                          }
                          title={
                            isLocked ? "Unlock component" : "Lock component"
                          }
                        />
                      )}
                      {canGroupByTime && (
                        <Tooltip
                          trigger={
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroupByTime(group);
                              }}
                              className={`${styles.iconButton} ${groupByTime ? styles.locked : ""}`}
                              aria-pressed={groupByTime}
                            >
                              <CompressLines width={16} height={16} />
                            </button>
                          }
                          title={
                            groupByTime
                              ? "Show individual sections"
                              : "Group by time"
                          }
                        />
                      )}
                    </div>
                  </div>
                  <p className={styles.time}>Time</p>
                </div>
                {timeGroups
                  ? timeGroups.map((slotSections) => {
                      if (slotSections.length === 1) {
                        const section = slotSections[0];
                        const active = selectedSections.some(
                          (selectedSection) =>
                            selectedSection.sectionId === section.sectionId
                        );
                        const isBlocked = Boolean(
                          blockedSections?.find(
                            (s) => s === section.sectionId
                          )
                        );
                        return (
                          <Section
                            active={active}
                            blocked={isBlocked}
                            editing={editing}
                            showCcn={false}
                            onBlockToggle={() => {
                              onSectionBlockToggle(
                                _class.subject,
                                _class.courseNumber,
                                _class.number,
                                section.sectionId,
                                !isBlocked
                              );
                            }}
                            onSectionMouseOut={onSectionMouseOut}
                            onSectionMouseOver={() =>
                              onSectionMouseOver(
                                _class.subject,
                                _class.courseNumber,
                                _class.number,
                                section.number
                              )
                            }
                            onSectionSelect={() =>
                              onSectionSelect(
                                _class.subject,
                                _class.courseNumber,
                                _class.number,
                                section.number
                              )
                            }
                            {...section}
                            key={section.sectionId}
                          />
                        );
                      }

                      const selectedInSlot = slotSections.find((section) =>
                        selectedSections.some(
                          (selected) =>
                            selected.sectionId === section.sectionId
                        )
                      );
                      return (
                        <TimeSlotGroup
                          key={slotSections
                            .map((section) => section.sectionId)
                            .join("-")}
                          sections={slotSections}
                          selectedSectionId={selectedInSlot?.sectionId ?? null}
                          blockedSectionIds={blockedSections ?? []}
                          editing={editing}
                          onSectionMouseOut={onSectionMouseOut}
                          onSectionMouseOver={(sectionNumber) =>
                            onSectionMouseOver(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              sectionNumber
                            )
                          }
                          onSectionSelect={(sectionNumber) =>
                            onSectionSelect(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              sectionNumber
                            )
                          }
                          onBlockToggle={(blocked) => {
                            for (const section of slotSections) {
                              const currentlyBlocked = Boolean(
                                blockedSections?.find(
                                  (s) => s === section.sectionId
                                )
                              );
                              if (currentlyBlocked === blocked) continue;
                              onSectionBlockToggle(
                                _class.subject,
                                _class.courseNumber,
                                _class.number,
                                section.sectionId,
                                blocked
                              );
                            }
                          }}
                        />
                      );
                    })
                  : sectionList.map((section) => {
                      const active = selectedSections.some(
                        (selectedSection) =>
                          selectedSection.sectionId === section.sectionId
                      );
                      const isBlocked = blockedSections?.find(
                        (s) => s === section.sectionId
                      )
                        ? true
                        : false;

                      return (
                        <Section
                          active={active}
                          blocked={isBlocked}
                          editing={editing}
                          onBlockToggle={() => {
                            onSectionBlockToggle(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.sectionId,
                              !isBlocked
                            );
                          }}
                          onSectionMouseOut={onSectionMouseOut}
                          onSectionMouseOver={() =>
                            onSectionMouseOver(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.number
                            )
                          }
                          onSectionSelect={() =>
                            onSectionSelect(
                              _class.subject,
                              _class.courseNumber,
                              _class.number,
                              section.number
                            )
                          }
                          {...section}
                          key={section.sectionId}
                        />
                      );
                    })}
              </div>
            );
          })}
        </ClassCard>
      </div>
    </ClassDrawer>
  );
}
