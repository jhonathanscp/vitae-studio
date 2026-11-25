import { CVData, TargetedCuration } from "../types/cv.model";

/**
 * Calibração Física Real A4 (96 DPI):
 * - Folha A4: 210mm (793.7px) x 297mm (1122.5px).
 * - Margens reais de impressão (@page): 12mm topo/base (90.7px) e 14mm laterais (105.8px).
 * - Largura útil de texto: 182mm (688px -> ~74 chars/linha).
 * - Piso equilibrado (82% de A4): 920px.
 * - Teto seguro (98% de A4): 1100px.
 */
export const A4_SHEET_HEIGHT_PX = 1122;
export const A4_MIN_FILL_HEIGHT_PX = 920;
export const A4_MAX_HEIGHT_PX = 1100;

export type SpacingMode = "normal" | "compact" | "relaxed";

export interface DensityBreakdown {
  padding: number;
  header: number;
  objective: number;
  experience: number;
  education: number;
  projects: number;
  certificates: number;
  skillsLanguages: number;
  sectionGaps: number;
  totalHeight: number;
}

export interface PruneResult {
  curation: TargetedCuration;
  estimatedHeight: number;
  fillPercentage: number;
  prunedLevelsApplied: number[];
  spacing: SpacingMode;
}

/**
 * Calcula com precisão física a altura estimada (px) no DOM e na impressão A4 (@page 12mm 14mm).
 */
export function estimateCVHeight(
  cv: CVData,
  curation: TargetedCuration,
  spacing: SpacingMode = "normal"
): DensityBreakdown {
  const mult = spacing === "compact" ? 0.72 : spacing === "relaxed" ? 1.28 : 1.0;
  const isAtsTheme = cv.style?.theme === "ats";
  const padding = 91;

  const activeTitle = curation.tailoredTitle || cv.personal.title;
  const header = 39 + (activeTitle ? 26 : 0) + 22 + Math.round(18 * mult);

  const objectiveText = (curation.tailoredObjective || cv.objective || "").trim();
  let objective = 0;
  if (objectiveText) {
    const lines = Math.max(1, Math.ceil(objectiveText.length / 90));
    const linePx = spacing === "compact" ? 18.7 : spacing === "relaxed" ? 21.1 : 20.0;
    objective = 29 + Math.round(lines * linePx);
  }

  const activeExps = cv.experience.filter(e => curation.experience[e.id]?.included);
  let experience = 0;
  if (activeExps.length > 0) {
    experience += 29;
    activeExps.forEach((exp, idx) => {
      const expCur = curation.experience[exp.id];
      const desc = (expCur?.tailoredDescription || exp.description || "").trim();
      const bullets = desc.split("\n").filter(b => b.trim().length > 0);

      let itemHeight = 22;
      const linePx = spacing === "compact" ? 17.4 : spacing === "relaxed" ? 19.4 : 18.1;
      bullets.forEach(bullet => {
        const cleanBullet = bullet.replace(/^[•\-\*]\s*/, "");
        const bulletLines = Math.max(1, Math.ceil(cleanBullet.length / 92));
        itemHeight += Math.round(bulletLines * linePx) + 3;
      });

      experience += itemHeight;
      if (idx < activeExps.length - 1) {
        experience += Math.round(14 * mult);
      }
    });
  }

  const activeEdus = cv.education.filter(e => curation.education[e.id]?.included);
  let education = 0;
  if (activeEdus.length > 0) {
    education += 29;
    activeEdus.forEach((edu, idx) => {
      const extraDescLines = edu.description?.trim() ? Math.ceil(edu.description.length / 92) : 0;
      education += 24 + extraDescLines * 17;
      if (idx < activeEdus.length - 1) education += Math.round(10 * mult);
    });
  }

  const activeProjs = (cv.projects || []).filter(p => curation.projects?.[p.id]?.included);
  let projects = 0;
  if (activeProjs.length > 0) {
    projects += 29;
    const linePx = spacing === "compact" ? 17.4 : spacing === "relaxed" ? 19.4 : 18.1;
    activeProjs.forEach((proj, idx) => {
      const projCur = curation.projects[proj.id];
      const desc = (projCur?.tailoredDescription || proj.description || "").trim();
      const lines = Math.max(1, Math.ceil(desc.length / 92));
      projects += 22 + Math.round(lines * linePx);
      if (idx < activeProjs.length - 1) projects += Math.round(12 * mult);
    });
  }

  const activeCerts = cv.certificates.filter(c => curation.certificates[c.id]?.included);
  let certificates = 0;
  if (activeCerts.length > 0) {
    certificates += 29;
    if (isAtsTheme) {
      certificates += activeCerts.length * 20;
    } else {
      const rows = Math.ceil(activeCerts.length / 2);
      certificates += rows * 22;
    }
  }

  let skillsLanguages = 0;
  const skillsCount = (curation.selectedSkills || cv.skills || []).length;
  const langsCount = (cv.languages || []).length;
  if (skillsCount > 0 || langsCount > 0) {
    const skillsPerRow = isAtsTheme ? 6.0 : 3.6;
    const skillLines = skillsCount > 0 ? Math.ceil(skillsCount / skillsPerRow) : 0;
    const skillsHeight = skillsCount > 0 ? 29 + skillLines * 26 : 0;
    const langsHeight = langsCount > 0 ? 29 + langsCount * 22 : 0;

    if (isAtsTheme) {
      skillsLanguages = skillsHeight + langsHeight + (skillsHeight > 0 && langsHeight > 0 ? Math.round(14 * mult) : 0);
    } else {
      skillsLanguages = Math.max(skillsHeight, langsHeight);
    }
  }

  let visibleSections = 1;
  if (objective > 0) visibleSections++;
  if (experience > 0) visibleSections++;
  if (education > 0) visibleSections++;
  if (projects > 0) visibleSections++;
  if (certificates > 0) visibleSections++;
  if (skillsLanguages > 0) visibleSections++;

  const sectionGaps = Math.max(0, (visibleSections - 1) * Math.round(15 * mult));

  const totalHeight =
    padding +
    header +
    objective +
    experience +
    education +
    projects +
    certificates +
    skillsLanguages +
    sectionGaps;

  return {
    padding,
    header,
    objective,
    experience,
    education,
    projects,
    certificates,
    skillsLanguages,
    sectionGaps,
    totalHeight
  };
}

function toFillPercentage(heightPx: number): number {
  return Math.round((heightPx / A4_SHEET_HEIGHT_PX) * 100);
}

/**
 * Equilíbrio visual de 1 página A4 (85%–95%) + poda progressiva apenas quando > 98%.
 */
export function pruneCurationToFitA4(
  cv: CVData,
  initialCuration: TargetedCuration
): PruneResult {
  const curation: TargetedCuration = {
    ...initialCuration,
    experience: Object.fromEntries(
      Object.entries(initialCuration.experience).map(([k, v]) => [k, { ...v }])
    ),
    projects: Object.fromEntries(
      Object.entries(initialCuration.projects || {}).map(([k, v]) => [k, { ...v }])
    ),
    education: Object.fromEntries(
      Object.entries(initialCuration.education).map(([k, v]) => [k, { ...v }])
    ),
    certificates: Object.fromEntries(
      Object.entries(initialCuration.certificates).map(([k, v]) => [k, { ...v }])
    ),
    selectedSkills: [...(initialCuration.selectedSkills || [])]
  };

  const prunedLevelsApplied: number[] = [];
  let spacing: SpacingMode =
    cv.style?.spacing === "compact"
      ? "compact"
      : cv.style?.spacing === "relaxed"
      ? "relaxed"
      : "normal";

  const activeExpList = cv.experience.filter(exp => curation.experience[exp.id]?.included);
  if (activeExpList.length > 3) {
    const sortedExps = [...activeExpList].sort((a, b) => {
      const scoreA = curation.experience[a.id].relevanceScore ?? 50;
      const scoreB = curation.experience[b.id].relevanceScore ?? 50;
      return scoreB - scoreA;
    });
    sortedExps.slice(3).forEach(exp => {
      curation.experience[exp.id].included = false;
    });
  }

  const remainingInitExps = cv.experience.filter(exp => curation.experience[exp.id]?.included);
  remainingInitExps.forEach((exp, idx) => {
    const maxBullets = idx === 0 ? 4 : 3;
    const expCur = curation.experience[exp.id];
    const desc = (expCur.tailoredDescription || exp.description || "").trim();
    const bullets = desc.split("\n").filter(b => b.trim().length > 0);
    if (bullets.length > maxBullets) {
      expCur.tailoredDescription = bullets.slice(0, maxBullets).join("\n");
    }
  });

  const initialProjIds = Object.keys(curation.projects).filter(id => curation.projects[id].included);
  if (initialProjIds.length > 2) {
    const sortedProjs = [...initialProjIds].sort((a, b) => {
      const scoreA = curation.projects[a].relevanceScore ?? 50;
      const scoreB = curation.projects[b].relevanceScore ?? 50;
      return scoreB - scoreA;
    });
    sortedProjs.slice(2).forEach(id => {
      curation.projects[id].included = false;
    });
  }

  let density = estimateCVHeight(cv, curation, spacing);

  if (density.totalHeight < A4_MIN_FILL_HEIGHT_PX) {
    if (spacing === "compact") {
      spacing = "normal";
      density = estimateCVHeight(cv, curation, spacing);
    }

    const currentProjIds = (cv.projects || [])
      .map(p => p.id)
      .filter(id => curation.projects[id]?.included);
    if (currentProjIds.length < 2 && density.totalHeight < A4_MIN_FILL_HEIGHT_PX) {
      const excludedProjs = (cv.projects || [])
        .filter(p => curation.projects[p.id] && !curation.projects[p.id].included)
        .sort((a, b) => (curation.projects[b.id].relevanceScore ?? 0) - (curation.projects[a.id].relevanceScore ?? 0));

      for (const proj of excludedProjs) {
        if (Object.values(curation.projects).filter(p => p.included).length >= 2) break;
        if ((curation.projects[proj.id].relevanceScore ?? 0) < 55) break;
        curation.projects[proj.id].included = true;
        const nextDensity = estimateCVHeight(cv, curation, spacing);
        if (nextDensity.totalHeight <= A4_MAX_HEIGHT_PX) {
          density = nextDensity;
        } else {
          curation.projects[proj.id].included = false;
          break;
        }
      }
    }

    if (density.totalHeight < A4_MIN_FILL_HEIGHT_PX) {
      const activeCertCount = cv.certificates.filter(c => curation.certificates[c.id]?.included).length;
      const excludedCerts = cv.certificates
        .filter(c => curation.certificates[c.id] && !curation.certificates[c.id].included)
        .sort((a, b) => (curation.certificates[b.id].relevanceScore ?? 0) - (curation.certificates[a.id].relevanceScore ?? 0));

      let count = activeCertCount;
      for (const cert of excludedCerts) {
        if (count >= 2 || density.totalHeight >= A4_MIN_FILL_HEIGHT_PX) break;
        curation.certificates[cert.id].included = true;
        const nextDensity = estimateCVHeight(cv, curation, spacing);
        if (nextDensity.totalHeight <= A4_MAX_HEIGHT_PX) {
          density = nextDensity;
          count++;
        } else {
          curation.certificates[cert.id].included = false;
          break;
        }
      }
    }

    const currentExpCount = cv.experience.filter(e => curation.experience[e.id]?.included).length;
    if (density.totalHeight < A4_MIN_FILL_HEIGHT_PX && currentExpCount < 3) {
      const excludedExps = cv.experience
        .filter(e => curation.experience[e.id] && !curation.experience[e.id].included)
        .sort((a, b) => (curation.experience[b.id].relevanceScore ?? 0) - (curation.experience[a.id].relevanceScore ?? 0));

      for (const exp of excludedExps) {
        if (density.totalHeight >= A4_MIN_FILL_HEIGHT_PX) break;
        if ((curation.experience[exp.id].relevanceScore ?? 0) < 55) break;
        curation.experience[exp.id].included = true;
        const nextDensity = estimateCVHeight(cv, curation, spacing);
        if (nextDensity.totalHeight <= A4_MAX_HEIGHT_PX) {
          density = nextDensity;
          break;
        } else {
          curation.experience[exp.id].included = false;
        }
      }
    }

    if (density.totalHeight < A4_MIN_FILL_HEIGHT_PX) {
      const relaxedDensity = estimateCVHeight(cv, curation, "relaxed");
      if (relaxedDensity.totalHeight <= A4_MAX_HEIGHT_PX) {
        spacing = "relaxed";
        density = relaxedDensity;
      }
    }
  }

  if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
    return {
      curation,
      estimatedHeight: density.totalHeight,
      fillPercentage: toFillPercentage(density.totalHeight),
      prunedLevelsApplied,
      spacing
    };
  }

  let step1Triggered = false;
  if (curation.selectedSkills.length > 12) {
    curation.selectedSkills = curation.selectedSkills.slice(0, 12);
    step1Triggered = true;
  }

  const activeCertIds = Object.keys(curation.certificates).filter(id => curation.certificates[id].included);
  if (activeCertIds.length > 0) {
    activeCertIds.forEach(id => {
      curation.certificates[id].included = false;
    });
    step1Triggered = true;
  }

  if (step1Triggered) {
    prunedLevelsApplied.push(1);
    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }
  }

  if (curation.selectedSkills.length > 10) {
    curation.selectedSkills = curation.selectedSkills.slice(0, 10);
    if (!prunedLevelsApplied.includes(1)) prunedLevelsApplied.push(1);
    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }
  }

  const activeProjIds = Object.keys(curation.projects).filter(id => curation.projects[id].included);
  if (activeProjIds.length > 1) {
    prunedLevelsApplied.push(2);
    const sortedProjs = [...activeProjIds].sort((a, b) => {
      const scoreA = curation.projects[a].relevanceScore ?? 50;
      const scoreB = curation.projects[b].relevanceScore ?? 50;
      return scoreA - scoreB;
    });
    curation.projects[sortedProjs[0]].included = false;

    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }
  }

  const expsStep3 = cv.experience.filter(exp => curation.experience[exp.id]?.included);
  if (expsStep3.length > 0) {
    let step3Triggered = false;

    expsStep3.slice(1).forEach(exp => {
      const expCur = curation.experience[exp.id];
      const desc = (expCur.tailoredDescription || exp.description || "").trim();
      const bullets = desc.split("\n").filter(b => b.trim().length > 0);
      if (bullets.length > 2) {
        expCur.tailoredDescription = bullets.slice(0, 2).join("\n");
        step3Triggered = true;
      }
    });

    if (step3Triggered) {
      prunedLevelsApplied.push(3);
      density = estimateCVHeight(cv, curation, spacing);
      if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
        return {
          curation,
          estimatedHeight: density.totalHeight,
          fillPercentage: toFillPercentage(density.totalHeight),
          prunedLevelsApplied,
          spacing
        };
      }
    }

    const primaryExp = expsStep3[0];
    const primaryCur = curation.experience[primaryExp.id];
    const primaryDesc = (primaryCur.tailoredDescription || primaryExp.description || "").trim();
    const primaryBullets = primaryDesc.split("\n").filter(b => b.trim().length > 0);
    if (primaryBullets.length > 3) {
      primaryCur.tailoredDescription = primaryBullets.slice(0, 3).join("\n");
      if (!prunedLevelsApplied.includes(3)) prunedLevelsApplied.push(3);
      density = estimateCVHeight(cv, curation, spacing);
      if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
        return {
          curation,
          estimatedHeight: density.totalHeight,
          fillPercentage: toFillPercentage(density.totalHeight),
          prunedLevelsApplied,
          spacing
        };
      }
    }

    if (expsStep3.length > 2) {
      if (!prunedLevelsApplied.includes(3)) prunedLevelsApplied.push(3);
      const sortedExps = [...expsStep3].sort((a, b) => {
        const scoreA = curation.experience[a.id].relevanceScore ?? 50;
        const scoreB = curation.experience[b.id].relevanceScore ?? 50;
        return scoreA - scoreB;
      });
      curation.experience[sortedExps[0].id].included = false;

      density = estimateCVHeight(cv, curation, spacing);
      if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
        return {
          curation,
          estimatedHeight: density.totalHeight,
          fillPercentage: toFillPercentage(density.totalHeight),
          prunedLevelsApplied,
          spacing
        };
      }
    }
  }

  if (spacing === "relaxed") {
    spacing = "normal";
    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }
  }

  if (spacing !== "compact") {
    spacing = "compact";
    prunedLevelsApplied.push(4);
    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }
  }

  const remainingExps = cv.experience.filter(exp => curation.experience[exp.id]?.included);
  if (remainingExps.length > 0 && density.totalHeight > A4_MAX_HEIGHT_PX) {
    remainingExps.slice(1).forEach(exp => {
      const expCur = curation.experience[exp.id];
      const desc = (expCur.tailoredDescription || exp.description || "").trim();
      const bullets = desc.split("\n").filter(b => b.trim().length > 0);
      if (bullets.length > 1) {
        expCur.tailoredDescription = bullets.slice(0, 1).join("\n");
        if (!prunedLevelsApplied.includes(3)) prunedLevelsApplied.push(3);
      }
    });

    density = estimateCVHeight(cv, curation, spacing);
    if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
      return {
        curation,
        estimatedHeight: density.totalHeight,
        fillPercentage: toFillPercentage(density.totalHeight),
        prunedLevelsApplied,
        spacing
      };
    }

    const remPrimary = remainingExps[0];
    if (remPrimary) {
      const remCur = curation.experience[remPrimary.id];
      const remDesc = (remCur.tailoredDescription || remPrimary.description || "").trim();
      const remBullets = remDesc.split("\n").filter(b => b.trim().length > 0);
      if (remBullets.length > 2) {
        remCur.tailoredDescription = remBullets.slice(0, 2).join("\n");
        if (!prunedLevelsApplied.includes(3)) prunedLevelsApplied.push(3);
      }
      density = estimateCVHeight(cv, curation, spacing);
      if (density.totalHeight <= A4_MAX_HEIGHT_PX) {
        return {
          curation,
          estimatedHeight: density.totalHeight,
          fillPercentage: toFillPercentage(density.totalHeight),
          prunedLevelsApplied,
          spacing
        };
      }
    }
  }

  const finalProjIds = Object.keys(curation.projects).filter(id => curation.projects[id].included);
  if (finalProjIds.length > 0 && density.totalHeight > A4_MAX_HEIGHT_PX) {
    finalProjIds.forEach(id => {
      curation.projects[id].included = false;
    });
    if (!prunedLevelsApplied.includes(2)) prunedLevelsApplied.push(2);
    density = estimateCVHeight(cv, curation, spacing);
  }

  if (curation.selectedSkills.length > 8 && density.totalHeight > A4_MAX_HEIGHT_PX) {
    curation.selectedSkills = curation.selectedSkills.slice(0, 8);
    density = estimateCVHeight(cv, curation, spacing);
  }

  return {
    curation,
    estimatedHeight: density.totalHeight,
    fillPercentage: toFillPercentage(density.totalHeight),
    prunedLevelsApplied,
    spacing
  };
}
