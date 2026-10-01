import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface JournalPacket { heroes: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>>; reflections: Array<Record<string, unknown>>; expeditions: Array<Record<string, unknown>>; }

export function exportCampaignJournal(outputDirectory: string, resume: JournalPacket, campaignId: string, exportedAt: string, activeExpeditionId?: string): { directory: string; files: string[] } {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });

  const files: string[] = [];
  const writeAtomic = (name: string, contents: string) => {
    const target = join(directory, name);
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, contents, "utf8");
    try {
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    files.push(target);
  };

  writeAtomic(
    "campaign.md",
    [
      `# DD1 战役：${campaignId}`,
      "",
      `- 导出时间：${exportedAt}`,
      `- 当前远征：${activeExpeditionId ?? "无"}`,
      `- 英雄档案：${resume.heroes.length}`,
      `- 已记录决策：${resume.decisions.length}`,
      `- 复盘条目：${resume.reflections.length}`,
      "",
      "## 近期复盘",
      "",
      ...resume.reflections.flatMap((item) => [
        `### ${String(item.title)}`,
        "",
        `${String(item.body)}`,
        "",
        `类型：${String(item.kind)}；时间：${String(item.createdAt)}`,
        "",
      ]),
    ].join("\n"),
  );

  writeAtomic(
    "heroes.md",
    [
      "# 英雄档案",
      "",
      ...resume.heroes.flatMap((item) => {
        const profile = item.profile as Record<string, unknown>;
        return [
          `## ${String(item.name)}（GUID ${String(item.heroGuid)}）`,
          "",
          `- 最近状态版本：${String(item.revision)}`,
          `- 特质：${(profile.quirks as unknown[] | undefined)?.join("；") || "无记录"}`,
          `- 疾病：${(profile.diseases as unknown[] | undefined)?.join("；") || "无记录"}`,
          `- 抗性：${(profile.resists as unknown[] | undefined)?.join("；") || "无记录"}`,
          "",
        ];
      }),
    ].join("\n"),
  );

  writeAtomic(
    "expeditions.md",
    [
      "# 远征与决策记录",
      "",
      "## 远征",
      "",
      ...resume.expeditions.map(
        (item) =>
          `- ${String(item.startedAt)}｜${String(item.status)}｜版本 ${String(item.startRevision)}→${String(item.endRevision ?? "进行中")}`,
      ),
      "",
      "## 决策",
      "",
      ...resume.decisions.flatMap((item) => [
        `### ${String(item.completedAt)}｜${String(item.outcome)}`,
        "",
        `- 行动：\`${JSON.stringify(item.action)}\``,
        `- 理由：${String(item.rationale ?? "未记录")}`,
        `- 核验：${String(item.reason)}`,
        "",
      ]),
    ].join("\n"),
  );
  return { directory, files };
}
