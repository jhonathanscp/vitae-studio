import axios, { isAxiosError } from "axios";
import { CVData, TargetedCuration, ItemCuration } from "../../common/model/cv.model";
import { ENRICHMENT_GEMINI_PROMPT } from "../gemini/gemini.prompt";
import {
    RESUME_EXTRACTION_PROMPT,
    RESUME_EXTRACTION_SYSTEM_PROMPT_EN,
    buildResumeExtractionUserPayload
} from "../parser/resume-extraction.prompt";
import {
    JobCurationInput,
    CURATION_GEMINI_PROMPT,
    CURATION_SYSTEM_PROMPT_EN,
    buildCurationUserPayload
} from "../gemini/curation.prompt";
import { enrichedCVSchema } from "../../http/schema/task.schema";
import { logger } from "../../../util/logger";
import {
    cleanJobDescription,
    extractJobKeywords
} from "../ats/text-sanitizer";
import {
    ATS_SYSTEM_PROMPT_EN,
    buildAtsUserPrompt,
    OptimizationItemInput
} from "../ats/ats-diff.prompt";
import { pruneCurationToFitA4 } from "../ats/a4-density-pruner";
import {
    ConfigurationError,
    GeminiInvalidResponseError,
    GeminiQuotaExhaustedError
} from "../../../util/errors";

export function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/chat\/completions$/i, "")
        .replace(/\/models$/i, "")
        .replace(/\/+$/, "");
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    if (apiKey && apiKey.trim() !== "") {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    return headers;
}

export function isReasoningModelName(model: string): boolean {
    return /(?:reason|r1|think|flash|qwq|(?:^|[/:_-])o[134](?:$|[/:_-])|gemini-2\.5|gemini-3)/i.test(model);
}

export const REASONING_MODEL_MAX_TOKENS = 20480;
export const STANDARD_MODEL_MAX_TOKENS = 8192;
const MAX_TOKENS_FALLBACK_TIERS = [16384, 8192, 4096] as const;
const REASONING_COMPLETION_TIMEOUT_MS = 240000;
const STANDARD_COMPLETION_TIMEOUT_MS = 120000;

export function getCompletionMaxTokens(model: string): number {
    return isReasoningModelName(model)
        ? REASONING_MODEL_MAX_TOKENS
        : STANDARD_MODEL_MAX_TOKENS;
}

function getCompletionTimeoutMs(model: string): number {
    return isReasoningModelName(model)
        ? REASONING_COMPLETION_TIMEOUT_MS
        : STANDARD_COMPLETION_TIMEOUT_MS;
}

export function resolveFallbackMaxTokens(currentMaxTokens: number, errorDetail: string): number | null {
    const rangeMatch = errorDetail.match(
        /(?:\[\s*\d+\s*(?:,|\.\.)\s*|between\s+\d+\s+and\s+)(\d{3,6})/i
    );
    const limitMatch = errorDetail.match(
        /(?:at most|maximum(?:\s+allowed)?(?:\s+value)?(?:\s+of|\s+is)?|<=|cannot exceed|exceeds(?:\s+the)?(?:\s+maximum|\s+limit)?(?:\s+of)?|less than or equal to|greater than|\d+\s*\)?\s*>\s*)\s*(\d{3,6})/i
    );

    const rawParsed = rangeMatch?.[1] ?? limitMatch?.[1];
    if (rawParsed) {
        const parsedLimit = Number.parseInt(rawParsed, 10);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 1024 && parsedLimit < currentMaxTokens) {
            return parsedLimit;
        }
    }

    const nextTier = MAX_TOKENS_FALLBACK_TIERS.find(tier => tier < currentMaxTokens);
    return nextTier ?? null;
}

function isMaxTokens400Error(err: unknown): { matched: boolean; detail: string } {
    if (!isAxiosError(err) || err.response?.status !== 400) {
        return { matched: false, detail: "" };
    }

    const detail = extractAxiosErrorDetail(err);
    const param = (err.response?.data as any)?.error?.param;
    const matched =
        param === "max_tokens" ||
        param === "max_completion_tokens" ||
        /max_(?:tokens|output_tokens|completion_tokens)|completion tokens|in the completion/i.test(detail);

    return { matched, detail };
}

export function extractRawContentFromChoice(choice: any): string | null {
    if (!choice) return null;

    // 1. Padrão primário OpenAI (message.content)
    if (typeof choice.message?.content === "string" && choice.message.content.trim()) {
        return choice.message.content.trim();
    }

    // 2. Endpoints legacy completions (choice.text)
    if (typeof choice.text === "string" && choice.text.trim()) {
        return choice.text.trim();
    }

    // 3. Modelos com Reasoning (DeepSeek R1 / flash / OpenRouter) que emitiram o retorno em reasoning_content
    if (typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content.trim()) {
        return choice.message.reasoning_content.trim();
    }

    if (typeof choice.message?.reasoning === "string" && choice.message.reasoning.trim()) {
        return choice.message.reasoning.trim();
    }

    return null;
}

function hasPrimaryChoiceContent(choice: any): boolean {
    return (
        (typeof choice?.message?.content === "string" && choice.message.content.trim().length > 0) ||
        (typeof choice?.text === "string" && choice.text.trim().length > 0)
    );
}

function resolveChoiceContent(params: {
    choice: any;
    usage: any;
    maxTokens: number;
    logTag: string;
    emptyErrorMessage: string;
}): { data: string; err?: undefined } | { err: GeminiInvalidResponseError; data?: undefined } {
    const { choice, usage, maxTokens, logTag, emptyErrorMessage } = params;
    const finishReason = choice?.finish_reason;
    const rawContent = extractRawContentFromChoice(choice);
    const primaryPresent = hasPrimaryChoiceContent(choice);
    const completionTokens = usage?.completion_tokens;

    if (finishReason === "length") {
        if (!primaryPresent) {
            logger.warn(
                { choice, usage },
                `${logTag} Token limit reached during reasoning before generating JSON content`
            );
            return {
                err: new GeminiInvalidResponseError(
                    `O modelo de IA esgotou o limite de tokens (${completionTokens || maxTokens} tokens) durante o raciocínio antes de gerar o conteúdo JSON. Recomendamos utilizar o modelo 'deepseek-chat' (DeepSeek V3) para geração direta e rápida sem gasto excessivo com thinking.`
                )
            };
        }

        logger.warn(
            { finishReason, completionTokens, tail: rawContent?.slice(-120) },
            `${logTag} Response was truncated at token limit`
        );
        return {
            err: new GeminiInvalidResponseError(
                `A resposta da IA foi cortada ao atingir o limite de tokens (${completionTokens || maxTokens} tokens). Recomendamos utilizar o modelo 'deepseek-chat' para geração completa sem cortes.`
            )
        };
    }

    if (!rawContent) {
        logger.warn({ choice, usage }, `${logTag} Empty choice received`);
        return {
            err: new GeminiInvalidResponseError(emptyErrorMessage)
        };
    }

    if (!primaryPresent && !rawContent.includes("{")) {
        logger.warn(
            { choice, usage, preview: rawContent.slice(0, 200) },
            `${logTag} Provider returned reasoning-only prose without JSON object`
        );
        return {
            err: new GeminiInvalidResponseError(
                `O modelo de IA retornou apenas texto de raciocínio sem gerar o JSON final (${completionTokens || maxTokens} tokens). Tente novamente ou utilize o modelo 'deepseek-chat'.`
            )
        };
    }

    return { data: rawContent };
}

export function stripTechQuotes(text: string): string {
    if (!text) return "";
    return text
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(^|[\s,(])'([A-Za-z0-9][A-Za-z0-9.+#\/\- ]{0,25})'(?=[.,;:)\s]|$)/g, "$1$2");
}

export function stripBulletPrefixes(desc: string): string {
    if (!desc) return "";
    return desc.replace(
        /^([•\-\*]\s*)(?!(?:Desenvolvi|Implementei|Estruturei|Automatizei|Otimizei|Liderei|Criei|Arquitetei|Construí|Modelei|Integrei|Reduzi|Gerenciei|Refatorei|Atuei|Conduzi|Diagnostiquei|Prestei|Solucionei|Documentei|Registrei|Apoiei|Coordenei|Monitorei|Administrei|Analisei|Propus)\b)[A-ZÀ-Ú][A-Za-zÀ-Ú0-9\s\/\-]{2,28}:\s+(?=[A-ZÀ-Ú])/gm,
        "$1"
    );
}

function findLastBalancedJsonObject(text: string): unknown | undefined {
    const spans: Array<[number, number]> = [];
    let inString = false;
    let isEscaped = false;
    let depth = 0;
    let startIdx = -1;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            } else if (char === "\\") {
                isEscaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
        } else if (char === "{") {
            if (depth === 0) {
                startIdx = i;
            }
            depth++;
        } else if (char === "}") {
            if (depth > 0) {
                depth--;
                if (depth === 0 && startIdx !== -1) {
                    spans.push([startIdx, i + 1]);
                    startIdx = -1;
                }
            }
        }
    }

    for (let i = spans.length - 1; i >= 0; i--) {
        const [start, end] = spans[i];
        const candidate = text.slice(start, end);
        for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
            try {
                const parsed = JSON.parse(attempt);
                if (parsed !== null && typeof parsed === "object") {
                    return parsed;
                }
            } catch {
                // Continue trying earlier balanced JSON candidates
            }
        }
    }

    return undefined;
}

export function extractJsonFromText(
    rawText: string,
    options?: { rejectTruncated?: boolean }
): unknown {
    if (typeof rawText !== "string") {
        return rawText;
    }

    let cleaned = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();

    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        cleaned = fenceMatch[1].trim();
    } else {
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        } else if (firstBrace !== -1) {
            cleaned = cleaned.slice(firstBrace);
        }
    }

    // 1. Direct parse attempt
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        // Continue to resilient repairs
    }

    // 2. Remove trailing commas before closing braces/brackets
    const noTrailingCommas = cleaned.replace(/,\s*([}\]])/g, "$1");
    try {
        return JSON.parse(noTrailingCommas);
    } catch (_) {
        // Continue to balanced object scan & character-stream repair
    }

    const lastBalanced = findLastBalancedJsonObject(cleaned);
    if (lastBalanced !== undefined) {
        return lastBalanced;
    }

    if (!noTrailingCommas.includes("{") && !noTrailingCommas.includes("[")) {
        logger.warn(
            { original: rawText.slice(0, 300) },
            "[extractJsonFromText] No JSON braces/brackets found in model response"
        );
        throw new GeminiInvalidResponseError(
            "A IA retornou uma resposta em texto sem objeto JSON válido. Tente novamente ou selecione o modelo 'deepseek-chat'."
        );
    }

    // 3. Resilient repair of unescaped quotes, unescaped newlines/tabs, and truncation
    let repaired = "";
    let inString = false;
    let isEscaped = false;
    const stack: string[] = [];

    const isFollowedByValidToken = (str: string, quoteIndex: number): boolean => {
        let idx = quoteIndex + 1;
        while (idx < str.length && /\s/.test(str[idx])) idx++;
        if (idx >= str.length) return true; // End of input

        const nextChar = str[idx];
        if (nextChar === ":" || nextChar === "}" || nextChar === "]") return true;

        if (nextChar === ",") {
            let afterComma = idx + 1;
            while (afterComma < str.length && /\s/.test(str[afterComma])) afterComma++;
            if (afterComma >= str.length) return true;

            const c = str[afterComma];
            if (c === "}" || c === "]") return true;

            const currentContext = stack[stack.length - 1];
            if (currentContext === "{") {
                if (c !== "\"") return false;
                let kIdx = afterComma + 1;
                while (kIdx < str.length) {
                    if (str[kIdx] === "\\") { kIdx += 2; continue; }
                    if (str[kIdx] === "\"") break;
                    kIdx++;
                }
                if (kIdx >= str.length) return false;
                kIdx++;
                while (kIdx < str.length && /\s/.test(str[kIdx])) kIdx++;
                return str[kIdx] === ":";
            }

            if (currentContext === "[") {
                return c === "\"" || c === "{" || c === "[" || /[0-9tfn\-]/.test(c);
            }

            return true;
        }

        return false;
    };

    for (let i = 0; i < noTrailingCommas.length; i++) {
        const char = noTrailingCommas[i];

        if (!inString) {
            if (char === "{" || char === "[") {
                stack.push(char);
                repaired += char;
            } else if (char === "}") {
                if (stack[stack.length - 1] === "{") stack.pop();
                repaired += char;
            } else if (char === "]") {
                if (stack[stack.length - 1] === "[") stack.pop();
                repaired += char;
            } else if (char === "\"") {
                inString = true;
                repaired += char;
            } else {
                repaired += char;
            }
        } else {
            if (isEscaped) {
                repaired += char;
                isEscaped = false;
            } else if (char === "\\") {
                repaired += char;
                isEscaped = true;
            } else if (char === "\n") {
                repaired += "\\n";
            } else if (char === "\r") {
                repaired += "\\r";
            } else if (char === "\t") {
                repaired += "\\t";
            } else if (char === "\"") {
                if (isFollowedByValidToken(noTrailingCommas, i)) {
                    inString = false;
                    repaired += char;
                } else {
                    repaired += "\\\"";
                }
            } else {
                repaired += char;
            }
        }
    }

    const wasTruncated = inString || stack.length > 0;
    if (options?.rejectTruncated && wasTruncated) {
        logger.warn(
            { tail: noTrailingCommas.slice(-160), openStack: stack },
            "[extractJsonFromText] JSON truncated mid-stream; rejecting partial payload"
        );
        throw new GeminiInvalidResponseError(
            "A resposta da IA veio truncada antes de completar o JSON. Tente novamente ou use o modelo 'deepseek-chat'."
        );
    }

    if (inString) {
        repaired += "\"";
    }

    while (stack.length > 0) {
        const open = stack.pop();
        if (open === "{") repaired += "}";
        else if (open === "[") repaired += "]";
    }

    repaired = repaired.replace(/,\s*([}\]])/g, "$1");

    try {
        return JSON.parse(repaired);
    } catch (parseError: any) {
        logger.warn(
            { original: rawText.slice(0, 300), repaired: repaired.slice(0, 300), error: parseError?.message },
            "[extractJsonFromText] Failed to parse JSON even after resilient repairs"
        );
        throw new GeminiInvalidResponseError(
            `Falha ao interpretar JSON retornado pela IA: ${parseError?.message || "JSON inválido"}`
        );
    }
}

export function normalizeEnrichedCV(raw: any, originalCv: CVData): Omit<CVData, "style"> {
    const asStr = (val: unknown, fallback = ""): string =>
        typeof val === "string" ? val : val != null ? String(val) : fallback;

    const personalRaw = raw?.personal && typeof raw.personal === "object" ? raw.personal : {};
    const personal = {
        fullName: asStr(personalRaw.fullName, originalCv.personal.fullName),
        title: asStr(personalRaw.title, originalCv.personal.title),
        email: asStr(personalRaw.email, originalCv.personal.email),
        phone: asStr(personalRaw.phone, originalCv.personal.phone),
        location: asStr(personalRaw.location, originalCv.personal.location),
        linkedin: asStr(personalRaw.linkedin, originalCv.personal.linkedin),
        github: asStr(personalRaw.github, originalCv.personal.github)
    };

    const experience = Array.isArray(raw?.experience)
        ? raw.experience.map((item: any, idx: number) => ({
            id: asStr(item?.id, originalCv.experience[idx]?.id || String(idx + 1)),
            company: asStr(item?.company),
            role: asStr(item?.role),
            location: asStr(item?.location),
            startDate: asStr(item?.startDate),
            endDate: asStr(item?.endDate),
            description: asStr(item?.description)
        }))
        : originalCv.experience;

    const education = Array.isArray(raw?.education)
        ? raw.education.map((item: any, idx: number) => ({
            id: asStr(item?.id, originalCv.education[idx]?.id || String(idx + 1)),
            institution: asStr(item?.institution),
            degree: asStr(item?.degree),
            startDate: asStr(item?.startDate),
            endDate: asStr(item?.endDate),
            description: asStr(item?.description)
        }))
        : originalCv.education;

    const projects = Array.isArray(raw?.projects)
        ? raw.projects.map((item: any, idx: number) => ({
            id: asStr(item?.id, originalCv.projects?.[idx]?.id || String(idx + 1)),
            name: asStr(item?.name),
            role: asStr(item?.role),
            link: normalizeSocialUrl(item?.link),
            startDate: asStr(item?.startDate),
            endDate: asStr(item?.endDate),
            description: asStr(item?.description)
        }))
        : (originalCv.projects || []);

    const certificates = Array.isArray(raw?.certificates)
        ? raw.certificates.map((item: any, idx: number) => ({
            id: asStr(item?.id, originalCv.certificates[idx]?.id || String(idx + 1)),
            name: asStr(item?.name),
            organization: asStr(item?.organization),
            date: asStr(item?.date)
        }))
        : originalCv.certificates;

    const languages = Array.isArray(raw?.languages)
        ? raw.languages.map((item: any, idx: number) => ({
            id: asStr(item?.id, originalCv.languages[idx]?.id || String(idx + 1)),
            name: asStr(item?.name),
            level: asStr(item?.level)
        }))
        : originalCv.languages;

    const skills = Array.isArray(raw?.skills)
        ? raw.skills.map((s: unknown) => asStr(s)).filter(Boolean)
        : originalCv.skills;

    const candidate = {
        personal,
        objective: asStr(raw?.objective, originalCv.objective),
        experience,
        education,
        projects,
        certificates,
        skills,
        languages
    };

    return enrichedCVSchema.parse(candidate);
}

const VALID_LANGUAGE_LEVELS = new Set(["Nativo", "Fluente", "Avançado", "Intermediário", "Básico"]);

export function normalizeLanguageLevel(rawLevel: unknown): string {
    const val = typeof rawLevel === "string" ? rawLevel.trim() : "";
    if (VALID_LANGUAGE_LEVELS.has(val)) {
        return val;
    }

    const lower = val.toLowerCase();
    if (lower.includes("nativ") || lower.includes("matern") || lower.includes("native") || lower.includes("mother")) {
        return "Nativo";
    }
    if (lower.includes("fluent") || lower.includes("c2") || lower.includes("proficien")) {
        return "Fluente";
    }
    if (lower.includes("avan") || lower.includes("c1") || lower.includes("advanced")) {
        return "Avançado";
    }
    if (lower.includes("básic") || lower.includes("basic") || lower.includes("iniciante") || lower.includes("a1") || lower.includes("a2") || lower.includes("leitura")) {
        return "Básico";
    }
    return "Intermediário";
}

export function normalizeSocialUrl(rawUrl: unknown): string {
    if (typeof rawUrl !== "string") return "";
    return rawUrl
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/+$/, "");
}

export function normalizeEndDate(rawDate: unknown): string {
    if (typeof rawDate !== "string") return "";
    const trimmed = rawDate.trim();
    const lower = trimmed.toLowerCase();
    if (
        lower === "atual" ||
        lower === "atualmente" ||
        lower === "presente" ||
        lower === "present" ||
        lower === "current" ||
        lower === "em andamento" ||
        lower === "até o momento"
    ) {
        return "";
    }
    return trimmed;
}

export function normalizeExtractedCV(raw: any): Omit<CVData, "style"> {
    const asStr = (val: unknown, fallback = ""): string =>
        typeof val === "string" ? val.trim() : val != null ? String(val).trim() : fallback;

    const nowTag = Date.now();
    const personalRaw = raw?.personal && typeof raw.personal === "object" ? raw.personal : {};
    const personal = {
        fullName: asStr(personalRaw.fullName),
        title: asStr(personalRaw.title),
        email: asStr(personalRaw.email),
        phone: asStr(personalRaw.phone),
        location: asStr(personalRaw.location),
        linkedin: normalizeSocialUrl(personalRaw.linkedin),
        github: normalizeSocialUrl(personalRaw.github)
    };

    const experience = Array.isArray(raw?.experience)
        ? raw.experience
            .filter((item: any) => item && (item.company || item.role || item.description))
            .map((item: any, idx: number) => ({
                id: `exp-${nowTag}-${idx + 1}`,
                company: asStr(item?.company),
                role: asStr(item?.role),
                location: asStr(item?.location),
                startDate: asStr(item?.startDate),
                endDate: normalizeEndDate(item?.endDate),
                description: asStr(item?.description)
            }))
        : [];

    const education = Array.isArray(raw?.education)
        ? raw.education
            .filter((item: any) => item && (item.institution || item.degree))
            .map((item: any, idx: number) => ({
                id: `edu-${nowTag}-${idx + 1}`,
                institution: asStr(item?.institution),
                degree: asStr(item?.degree),
                startDate: asStr(item?.startDate),
                endDate: normalizeEndDate(item?.endDate),
                description: asStr(item?.description)
            }))
        : [];

    const projects = Array.isArray(raw?.projects)
        ? raw.projects
            .filter((item: any) => item && (item.name || item.description || item.role))
            .map((item: any, idx: number) => ({
                id: `proj-${nowTag}-${idx + 1}`,
                name: asStr(item?.name),
                role: asStr(item?.role),
                link: normalizeSocialUrl(item?.link),
                startDate: asStr(item?.startDate),
                endDate: normalizeEndDate(item?.endDate),
                description: asStr(item?.description)
            }))
        : [];

    const certificates = Array.isArray(raw?.certificates)
        ? raw.certificates
            .filter((item: any) => item && item.name)
            .map((item: any, idx: number) => ({
                id: `cert-${nowTag}-${idx + 1}`,
                name: asStr(item?.name),
                organization: asStr(item?.organization),
                date: asStr(item?.date)
            }))
        : [];

    const languages = Array.isArray(raw?.languages)
        ? raw.languages
            .filter((item: any) => item && item.name)
            .map((item: any, idx: number) => ({
                id: `lang-${nowTag}-${idx + 1}`,
                name: asStr(item?.name),
                level: normalizeLanguageLevel(item?.level)
            }))
        : [];

    const skills: string[] = Array.isArray(raw?.skills)
        ? Array.from(
            new Set(
                raw.skills
                    .map((s: unknown) => asStr(s))
                    .filter((s: string) => s.length > 0)
            )
        )
        : [];

    const candidate = {
        personal,
        objective: asStr(raw?.objective),
        experience,
        education,
        projects,
        certificates,
        skills,
        languages
    };

    return enrichedCVSchema.parse(candidate);
}

async function postToChatEndpointWithFormatFallback(
    targetUrl: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number
) {
    let currentPayload: Record<string, unknown> = { ...payload };

    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            return await axios.post(targetUrl, currentPayload, { headers, timeout: timeoutMs });
        } catch (err: unknown) {
            if (!isAxiosError(err) || err.response?.status !== 400) {
                throw err;
            }

            const maxTokensCheck = isMaxTokens400Error(err);
            if (maxTokensCheck.matched && typeof currentPayload.max_tokens === "number") {
                const nextMaxTokens = resolveFallbackMaxTokens(
                    currentPayload.max_tokens,
                    maxTokensCheck.detail
                );
                if (nextMaxTokens !== null) {
                    logger.warn(
                        {
                            previousMaxTokens: currentPayload.max_tokens,
                            fallbackMaxTokens: nextMaxTokens,
                            detail: maxTokensCheck.detail
                        },
                        "[OpenAI-Compatible] Provider rejected max_tokens; retrying with lower limit"
                    );
                    currentPayload = { ...currentPayload, max_tokens: nextMaxTokens };
                    continue;
                }
            }

            if ("response_format" in currentPayload) {
                const { response_format: _ignored, ...payloadWithoutFormat } = currentPayload;
                currentPayload = payloadWithoutFormat;
                continue;
            }

            throw err;
        }
    }

    return await axios.post(targetUrl, currentPayload, { headers, timeout: timeoutMs });
}

export function applyAtsDiffsToCV(
    cv: CVData,
    diffs: Array<{ id: string; improved: string | string[] }>,
    targetRole?: string,
    extractedKeywords?: string[]
): Omit<CVData, "style"> {
    const diffMap = new Map<string, string>();
    if (Array.isArray(diffs)) {
        for (const d of diffs) {
            if (d && d.id) {
                const normalized = normalizeTailoredText(d.improved, "", false);
                if (normalized) {
                    diffMap.set(String(d.id), normalized);
                }
            }
        }
    }

    const updatedExperience = cv.experience.map(exp => {
        const improved = diffMap.get(exp.id);
        return improved ? { ...exp, description: improved } : exp;
    });

    const updatedProjects = (cv.projects || []).map(proj => {
        const improved = diffMap.get(proj.id);
        return improved ? { ...proj, description: improved } : proj;
    });

    const currentSkills = new Set(cv.skills.map(s => s.trim()).filter(Boolean));
    if (extractedKeywords && extractedKeywords.length > 0) {
        for (const kw of extractedKeywords.slice(0, 5)) {
            const trimmed = kw.trim();
            if (trimmed.length > 2) {
                const formatted = trimmed.length <= 3 ? trimmed.toUpperCase() : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
                currentSkills.add(formatted);
            }
        }
    }

    const candidate = {
        personal: {
            ...cv.personal,
            title: targetRole && targetRole.trim() ? targetRole.trim() : cv.personal.title
        },
        objective: cv.objective,
        experience: updatedExperience,
        education: cv.education,
        projects: updatedProjects,
        certificates: cv.certificates,
        skills: Array.from(currentSkills),
        languages: cv.languages
    };

    return enrichedCVSchema.parse(candidate);
}

async function postChatCompletionsWithFallback(
    baseUrl: string,
    apiKey: string,
    payload: Record<string, unknown>,
    timeoutMs = 120000
) {
    const cleanBase = normalizeBaseUrl(baseUrl);
    const headers = buildAuthHeaders(apiKey);
    const primaryUrl = `${cleanBase}/chat/completions`;

    let response;
    try {
        response = await postToChatEndpointWithFormatFallback(primaryUrl, payload, headers, timeoutMs);
    } catch (err: unknown) {
        // Se o usuário informou http://localhost:20128 sem /v1 e recebeu 404, tenta com /v1
        if (isAxiosError(err) && err.response?.status === 404 && !cleanBase.endsWith("/v1")) {
            const fallbackUrl = `${cleanBase}/v1/chat/completions`;
            response = await postToChatEndpointWithFormatFallback(fallbackUrl, payload, headers, timeoutMs);
        } else {
            throw err;
        }
    }

    // Telemetria do DeepSeek: rastreia consumo e eficácia do Context Caching
    const usage = (response?.data as any)?.usage;
    if (usage) {
        logger.info(
            {
                model: payload.model,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens || 0,
                prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens || 0
            },
            "DeepSeek Token Usage & Context Cache Telemetry"
        );
    }

    return response;
}

export async function enrichCVWithOpenAICompatible(params: {
    rawHtml: string;
    cv: CVData;
    apiKey: string;
    model: string;
    baseUrl: string;
}): Promise<Result<GeminiQuotaExhaustedError | GeminiInvalidResponseError | ConfigurationError, Omit<CVData, "style">>> {
    const { rawHtml, cv, apiKey, model, baseUrl } = params;

    if (!baseUrl || !baseUrl.trim()) {
        return { err: new ConfigurationError("A Base URL do provedor compatível com OpenAI não foi configurada.") };
    }

    if (!model || !model.trim()) {
        return { err: new ConfigurationError("O modelo de IA não foi configurado.") };
    }

    // 1. Sanitiza texto da vaga e extrai keywords essenciais (reduz payload em ~80%)
    const cleanedJobText = cleanJobDescription(rawHtml);
    const keywords = extractJobKeywords(cleanedJobText);

    // 2. Extrai itens a otimizar (somente experiências e projetos com texto)
    const itemsToOptimize: OptimizationItemInput[] = [
        ...cv.experience
            .filter(e => e.description && e.description.trim())
            .map(e => ({
                id: e.id,
                text: e.description,
                role: e.role,
                company: e.company
            })),
        ...(cv.projects || [])
            .filter(p => p.description && p.description.trim())
            .map(p => ({
                id: p.id,
                text: p.description,
                role: p.role,
                company: p.name
            }))
    ];

    const targetRole = cv.personal.title || "Especialista";
    const userPrompt = buildAtsUserPrompt(targetRole, keywords, itemsToOptimize);
    const maxTokens = getCompletionMaxTokens(model);
    const timeoutMs = getCompletionTimeoutMs(model);

    try {
        const response = await postChatCompletionsWithFallback(
            baseUrl,
            apiKey,
            {
                model: model.trim(),
                messages: [
                    {
                        role: "system",
                        content: ATS_SYSTEM_PROMPT_EN
                    },
                    {
                        role: "user",
                        content: userPrompt
                    }
                ],
                temperature: 0.25,
                max_tokens: maxTokens,
                response_format: { type: "json_object" }
            },
            timeoutMs
        );

        const usage = response.data?.usage;
        if (usage) {
            logger.info(
                {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    cachedTokens: usage.prompt_cache_hit_tokens || 0,
                    totalTokens: usage.total_tokens
                },
                "[OpenAI-Compatible ATS Enrichment] Token usage details"
            );
        }

        const choice = response.data?.choices?.[0];
        const resolved = resolveChoiceContent({
            choice,
            usage,
            maxTokens,
            logTag: "[OpenAI-Compatible ATS Enrichment]",
            emptyErrorMessage: "O provedor de IA retornou uma resposta vazia ou em formato inesperado."
        });

        if (resolved.err) {
            return { err: resolved.err };
        }

        const parsed = extractJsonFromText(resolved.data, { rejectTruncated: true }) as any;

        // Se o retorno for no formato moderno de Diffs:
        if (parsed && Array.isArray(parsed.diffs)) {
            const enriched = applyAtsDiffsToCV(cv, parsed.diffs, targetRole, keywords);
            return { data: enriched };
        }

        // Fallback resiliente para modelos legados que devolveram o CV inteiro
        const validatedCV = normalizeEnrichedCV(parsed, cv);
        return { data: validatedCV };
    } catch (error: unknown) {
        return handleOpenAICompatibleError(error);
    }
}

export async function extractCVFromTextWithOpenAICompatible(params: {
    rawResumeText: string;
    apiKey: string;
    model: string;
    baseUrl: string;
}): Promise<Result<GeminiQuotaExhaustedError | GeminiInvalidResponseError | ConfigurationError, Omit<CVData, "style">>> {
    const { rawResumeText, apiKey, model, baseUrl } = params;

    if (!baseUrl || !baseUrl.trim()) {
        return { err: new ConfigurationError("A Base URL do provedor compatível com OpenAI não foi configurada.") };
    }

    if (!model || !model.trim()) {
        return { err: new ConfigurationError("O modelo de IA não foi configurado.") };
    }

    const maxTokens = getCompletionMaxTokens(model);
    const timeoutMs = getCompletionTimeoutMs(model);

    try {
        const response = await postChatCompletionsWithFallback(
            baseUrl,
            apiKey,
            {
                model: model.trim(),
                messages: [
                    {
                        role: "system",
                        content: RESUME_EXTRACTION_SYSTEM_PROMPT_EN
                    },
                    {
                        role: "user",
                        content: buildResumeExtractionUserPayload(rawResumeText)
                    }
                ],
                temperature: 0.1,
                max_tokens: maxTokens,
                response_format: { type: "json_object" }
            },
            timeoutMs
        );

        const usage = response.data?.usage;
        if (usage) {
            logger.info(
                {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    cachedTokens: usage.prompt_cache_hit_tokens || 0,
                    totalTokens: usage.total_tokens
                },
                "[OpenAI-Compatible Extraction] Token usage details"
            );
        }

        const choice = response.data?.choices?.[0];
        const resolved = resolveChoiceContent({
            choice,
            usage,
            maxTokens,
            logTag: "[OpenAI-Compatible Extraction]",
            emptyErrorMessage: "O provedor de IA retornou uma resposta vazia ou em formato inesperado durante a extração do currículo."
        });

        if (resolved.err) {
            return { err: resolved.err };
        }

        const parsed = extractJsonFromText(resolved.data, { rejectTruncated: true });
        const validatedCV = normalizeExtractedCV(parsed);

        return { data: validatedCV };
    } catch (error: unknown) {
        return handleOpenAICompatibleError(error);
    }
}

function normalizeTailoredText(rawDesc: unknown, fallback: string, cleanPrefixes = true): string {
    let text = "";
    if (Array.isArray(rawDesc)) {
        text = rawDesc
            .map(item => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean)
            .map(line => (line.startsWith("•") || line.startsWith("-") ? line : `• ${line}`))
            .join("\n");
    } else if (typeof rawDesc === "string" && rawDesc.trim()) {
        text = rawDesc.trim();
    }

    if (!text) return fallback;

    text = stripTechQuotes(text);
    if (cleanPrefixes) {
        text = stripBulletPrefixes(text);
    }
    return text.trim() || fallback;
}

export function normalizeCuratedResult(
    raw: any,
    originalCv: CVData,
    job: JobCurationInput
): TargetedCuration {
    // Log interno de diagnóstico do bloco _ats_mapping e remoção imediata antes de salvar/retornar
    if (raw?._ats_mapping && typeof raw._ats_mapping === "object") {
        logger.debug(
            { atsMapping: raw._ats_mapping },
            "[ATS Curation] Internal _ats_mapping plan captured (stripped from persisted TargetedCuration)"
        );
    }

    const matchScore = typeof raw?.matchScore === "number" && !isNaN(raw.matchScore)
        ? Math.min(100, Math.max(0, Math.round(raw.matchScore)))
        : 80;

    const matchedKeywords = Array.isArray(raw?.matchedKeywords)
        ? raw.matchedKeywords.map((k: unknown) => stripTechQuotes(String(k || "").trim())).filter(Boolean)
        : [];

    const missingKeywords = Array.isArray(raw?.missingKeywords)
        ? raw.missingKeywords.map((k: unknown) => stripTechQuotes(String(k || "").trim())).filter(Boolean)
        : [];

    const rawTitle = raw?.tailoredTitle ?? raw?.personal?.title;
    const tailoredTitle = typeof rawTitle === "string" && rawTitle.trim()
        ? stripTechQuotes(rawTitle.trim())
        : undefined;

    const rawObjective = raw?.tailoredObjective ?? raw?.objective;
    const tailoredObjective = typeof rawObjective === "string" && rawObjective.trim()
        ? stripTechQuotes(rawObjective.trim())
        : originalCv.objective;

    // Experience curation (suporta chave 'experienceCuration' ou 'experience', lookup por ID, empresa ou índice)
    const expMap: Record<string, ItemCuration> = {};
    const rawExpList = Array.isArray(raw?.experienceCuration)
        ? raw.experienceCuration
        : Array.isArray(raw?.experience)
        ? raw.experience
        : [];
    const rawExpLookup = new Map<string, any>();
    for (const item of rawExpList) {
        if (item && item.id != null) {
            rawExpLookup.set(String(item.id).trim(), item);
        }
    }

    originalCv.experience.forEach((exp, idx) => {
        let found = rawExpLookup.get(exp.id);
        if (!found && rawExpList.length > 0) {
            const candidateByCompany = exp.company
                ? rawExpList.find((it: any) =>
                    typeof it?.company === "string" &&
                    it.company.trim().toLowerCase() === exp.company.trim().toLowerCase()
                )
                : undefined;
            found = candidateByCompany || (rawExpList.length === originalCv.experience.length ? rawExpList[idx] : undefined);
        }

        if (found) {
            expMap[exp.id] = {
                included: found.included !== undefined ? Boolean(found.included) : idx < 3,
                relevanceScore: typeof found.relevanceScore === "number" ? found.relevanceScore : (idx < 2 ? 90 : 50),
                tailoredDescription: normalizeTailoredText(found.tailoredDescription ?? found.description, exp.description, true)
            };
        } else {
            expMap[exp.id] = {
                included: idx < 2,
                relevanceScore: idx < 2 ? 80 : 40,
                tailoredDescription: exp.description
            };
        }
    });

    // Project curation (suporta 'projectCuration' ou 'projects', lookup por ID, nome ou índice)
    const projMap: Record<string, ItemCuration> = {};
    const rawProjList = Array.isArray(raw?.projectCuration)
        ? raw.projectCuration
        : Array.isArray(raw?.projects)
        ? raw.projects
        : [];
    const rawProjLookup = new Map<string, any>();
    for (const item of rawProjList) {
        if (item && item.id != null) {
            rawProjLookup.set(String(item.id).trim(), item);
        }
    }

    (originalCv.projects || []).forEach((proj, idx) => {
        let found = rawProjLookup.get(proj.id);
        if (!found && rawProjList.length > 0) {
            const candidateByName = proj.name
                ? rawProjList.find((it: any) =>
                    typeof it?.name === "string" &&
                    it.name.trim().toLowerCase() === proj.name.trim().toLowerCase()
                )
                : undefined;
            found = candidateByName || (rawProjList.length === (originalCv.projects || []).length ? rawProjList[idx] : undefined);
        }

        if (found) {
            projMap[proj.id] = {
                included: found.included !== undefined ? Boolean(found.included) : idx < 2,
                relevanceScore: typeof found.relevanceScore === "number" ? found.relevanceScore : (idx < 2 ? 85 : 50),
                tailoredDescription: normalizeTailoredText(found.tailoredDescription ?? found.description, proj.description, false)
            };
        } else {
            projMap[proj.id] = {
                included: idx < 2,
                relevanceScore: idx < 2 ? 75 : 40,
                tailoredDescription: proj.description
            };
        }
    });

    // Education curation
    const eduMap: Record<string, ItemCuration> = {};
    const rawEduList = Array.isArray(raw?.educationCuration)
        ? raw.educationCuration
        : Array.isArray(raw?.education)
        ? raw.education
        : [];
    const rawEduLookup = new Map<string, any>();
    for (const item of rawEduList) {
        if (item && item.id != null) {
            rawEduLookup.set(String(item.id).trim(), item);
        }
    }

    originalCv.education.forEach((edu, idx) => {
        const found = rawEduLookup.get(edu.id) || (rawEduList.length === originalCv.education.length ? rawEduList[idx] : undefined);
        eduMap[edu.id] = {
            included: found ? Boolean(found.included) : idx === 0,
            relevanceScore: found && typeof found.relevanceScore === "number" ? found.relevanceScore : 90
        };
    });

    // Certificates curation
    const certMap: Record<string, ItemCuration> = {};
    const rawCertList = Array.isArray(raw?.certificateCuration)
        ? raw.certificateCuration
        : Array.isArray(raw?.certificates)
        ? raw.certificates
        : [];
    const rawCertLookup = new Map<string, any>();
    for (const item of rawCertList) {
        if (item && item.id != null) {
            rawCertLookup.set(String(item.id).trim(), item);
        }
    }

    originalCv.certificates.forEach((cert, idx) => {
        const found = rawCertLookup.get(cert.id) || (rawCertList.length === originalCv.certificates.length ? rawCertList[idx] : undefined);
        certMap[cert.id] = {
            included: found ? Boolean(found.included) : idx < 2,
            relevanceScore: found && typeof found.relevanceScore === "number" ? found.relevanceScore : 70
        };
    });

    // Selected skills (12 a 16 competências ordenadas por aderência)
    const rawSkillsSource = Array.isArray(raw?.selectedSkills)
        ? raw.selectedSkills
        : Array.isArray(raw?.skills)
        ? raw.skills
        : [];
    const rawSkills = rawSkillsSource
        .map((s: unknown) => stripTechQuotes(String(s || "").trim()))
        .filter(Boolean);
    const selectedSkills = rawSkills.length > 0 ? rawSkills.slice(0, 16) : originalCv.skills.slice(0, 14);

    // Objeto limpo sem _ats_mapping
    const rawResult: TargetedCuration = {
        jobTitle: job.roleTitle,
        company: job.company,
        matchScore,
        matchedKeywords,
        missingKeywords,
        tailoredTitle,
        tailoredObjective,
        experience: expMap,
        projects: projMap,
        education: eduMap,
        certificates: certMap,
        selectedSkills
    };

    // Equilíbrio visual de 1 página A4 (85%-95%) e poda progressiva apenas se > 98%
    const { curation: balancedCuration, estimatedHeight, fillPercentage, prunedLevelsApplied, spacing } =
        pruneCurationToFitA4(originalCv, rawResult);

    logger.info(
        { estimatedHeight, fillPercentage, spacing, prunedLevelsApplied },
        "[A4 Density Balance] Curated resume calibrated for 1-page A4"
    );

    return balancedCuration;
}

export async function curateCVWithOpenAICompatible(params: {
    job: JobCurationInput;
    cv: CVData;
    apiKey: string;
    model: string;
    baseUrl: string;
}): Promise<Result<GeminiQuotaExhaustedError | GeminiInvalidResponseError | ConfigurationError, TargetedCuration>> {
    const { job, cv, apiKey, model, baseUrl } = params;

    if (!baseUrl || !baseUrl.trim()) {
        return { err: new ConfigurationError("A Base URL do provedor compatível com OpenAI não foi configurada.") };
    }

    if (!model || !model.trim()) {
        return { err: new ConfigurationError("O modelo de IA não foi configurado.") };
    }

    // Descrição integral da vaga (sem pré-cortes), mantendo higienização de HTML
    const sanitizedJob: JobCurationInput = {
        ...job,
        jobDescription: cleanJobDescription(job.jobDescription, Infinity)
    };

    const userPrompt = buildCurationUserPayload(cv, sanitizedJob);

    // Orçamento de tokens: 8192 para modelos padrão (ex: deepseek-chat) e 20480 (~20k) para modelos reasoning/flash
    // que consomem tokens internos em reasoning_content antes de escrever o JSON
    const maxTokens = getCompletionMaxTokens(model);
    const timeoutMs = getCompletionTimeoutMs(model);

    try {
        const response = await postChatCompletionsWithFallback(
            baseUrl,
            apiKey,
            {
                model: model.trim(),
                messages: [
                    {
                        role: "system",
                        content: CURATION_SYSTEM_PROMPT_EN
                    },
                    {
                        role: "user",
                        content: userPrompt
                    }
                ],
                temperature: 0.3,
                max_tokens: maxTokens,
                response_format: { type: "json_object" }
            },
            timeoutMs
        );

        const usage = response.data?.usage;
        if (usage) {
            logger.info(
                {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    cachedTokens: usage.prompt_cache_hit_tokens || 0,
                    totalTokens: usage.total_tokens
                },
                "[OpenAI-Compatible Curation] Token usage details"
            );
        }

        const choice = response.data?.choices?.[0];
        const resolved = resolveChoiceContent({
            choice,
            usage,
            maxTokens,
            logTag: "[OpenAI-Compatible Curation]",
            emptyErrorMessage: "O provedor de IA retornou uma resposta vazia durante a curadoria da vaga."
        });

        if (resolved.err) {
            return { err: resolved.err };
        }

        const parsed = extractJsonFromText(resolved.data, { rejectTruncated: true }) as any;

        if (parsed && parsed._ats_mapping) {
            logger.info(
                { atsMapping: parsed._ats_mapping },
                "[OpenAI-Compatible Curation] Extracted _ats_mapping plan (will be stripped before saving)"
            );
        }

        const returnedExpList = Array.isArray(parsed?.experienceCuration)
            ? parsed.experienceCuration
            : Array.isArray(parsed?.experience)
            ? parsed.experience
            : [];

        if (cv.experience.length > 0 && returnedExpList.length === 0) {
            logger.warn(
                { parsedKeys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [] },
                "[OpenAI-Compatible Curation] Missing experienceCuration in AI response"
            );
            return {
                err: new GeminiInvalidResponseError(
                    "A IA não retornou a reescrita das experiências profissionais (payload incompleto). Tente novamente."
                )
            };
        }

        const curationResult = normalizeCuratedResult(parsed, cv, job);

        return { data: curationResult };
    } catch (error: unknown) {
        return handleOpenAICompatibleError(error);
    }
}

function extractAxiosErrorDetail(error: unknown): string {
    if (isAxiosError(error)) {
        const data = error.response?.data as any;
        const apiMsg =
            data?.error?.message ||
            (typeof data?.error === "string" ? data.error : null) ||
            data?.message ||
            error.message;
        return String(apiMsg || "Erro na comunicação com o provedor de IA.");
    }
    return error instanceof Error ? error.message : "Erro desconhecido no provedor de IA.";
}

export function handleOpenAICompatibleError(
    error: unknown
): { err: GeminiQuotaExhaustedError | GeminiInvalidResponseError | ConfigurationError } {
    if (error instanceof ConfigurationError) {
        return { err: error };
    }

    if (isAxiosError(error)) {
        const status = error.response?.status;
        const detail = extractAxiosErrorDetail(error);

        if (status === 429) {
            return { err: new GeminiQuotaExhaustedError(`Limite de taxa (429) atingido no provedor de IA: ${detail}`) };
        }

        if (status === 401 || status === 403) {
            return { err: new ConfigurationError(`Falha de autenticação (${status}) no provedor de IA: verifique sua API Key. (${detail})`) };
        }

        if (status === 404) {
            return { err: new ConfigurationError(`Endpoint ou modelo não encontrado (404) em ${error.config?.url || "baseUrl"}: ${detail}`) };
        }

        if (!error.response) {
            return { err: new ConfigurationError(`Não foi possível conectar ao endpoint de IA (${error.message}). Verifique se a Base URL está correta e acessível.`) };
        }

        return { err: new GeminiInvalidResponseError(`Erro HTTP ${status} do provedor de IA: ${detail}`) };
    }

    const msg = error instanceof Error ? error.message : "Erro ao processar resposta JSON da IA.";
    return { err: new GeminiInvalidResponseError(msg) };
}

export async function fetchOpenAICompatibleModels(params: {
    apiKey?: string;
    baseUrl: string;
}): Promise<string[]> {
    const cleanBase = normalizeBaseUrl(params.baseUrl);
    if (!cleanBase) {
        throw new ConfigurationError("Informe uma Base URL válida para listar os modelos.");
    }

    const headers = buildAuthHeaders(params.apiKey);
    let response;

    try {
        response = await axios.get(`${cleanBase}/models`, { headers, timeout: 15000 });
    } catch (err: unknown) {
        if (isAxiosError(err) && err.response?.status === 404 && !cleanBase.endsWith("/v1")) {
            response = await axios.get(`${cleanBase}/v1/models`, { headers, timeout: 15000 });
        } else {
            throw new Error(extractAxiosErrorDetail(err));
        }
    }

    const rawList = Array.isArray(response.data?.data)
        ? response.data.data
        : Array.isArray(response.data?.models)
        ? response.data.models
        : Array.isArray(response.data)
        ? response.data
        : [];

    const models: string[] = rawList
        .map((item: any) => (typeof item === "string" ? item : item?.id || item?.name))
        .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0);

    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

export async function testOpenAICompatibleConnection(params: {
    apiKey: string;
    model: string;
    baseUrl: string;
}): Promise<{ ok: boolean; message: string }> {
    const { apiKey, model, baseUrl } = params;
    const cleanBase = normalizeBaseUrl(baseUrl);

    if (!cleanBase) {
        return { ok: false, message: "A Base URL é obrigatória para este provedor." };
    }

    try {
        await postChatCompletionsWithFallback(
            cleanBase,
            apiKey,
            {
                model: model.trim() || "gpt-4o-mini",
                messages: [{ role: "user", content: "Responda apenas: OK" }],
                max_tokens: 5
            },
            20000
        );

        return {
            ok: true,
            message: `Conexão estabelecida com sucesso usando o modelo "${model}"!`
        };
    } catch (err: unknown) {
        const detail = extractAxiosErrorDetail(err);
        return {
            ok: false,
            message: `Falha ao testar conexão: ${detail}`
        };
    }
}
