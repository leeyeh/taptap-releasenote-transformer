import * as _ from "lodash";
import { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import { marked } from "marked";
import { compareVersions } from "compare-versions";
// import { valid } from "semver";
import * as prompts from "prompts";

const octokit = new Octokit();

type Release =
  RestEndpointMethodTypes["repos"]["listReleases"]["response"]["data"][0];

const getReleases = async () => {
  const { repoId } = await prompts([
    {
      type: "text",
      name: "repoId",
      message: "Repo ID (e.g. taptap/TapSDK-Unity)",
    },
  ]);
  const [owner, repo] = repoId.split("/");
  const releases = (
    await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
    })
  ).data;

  if (releases.length >= 100) {
    console.warn("WARNING: Fetched releases might be imcomplete");
  }

  return (
    releases
      .map((release) => ({
        ...release,
        tag_name: release.tag_name.replace(/^v/, ""),
      }))
      .filter((release) => !release.draft)
      // .filter((release) => valid(release.tag_name))
      .sort((a, b) => compareVersions(a.tag_name, b.tag_name))
      .reverse()
  );
};

// const md = `
// ### TapFriends
// #### Optimization and fixed bugs
// - 分享链接支持自**定义**用户名称及配置额外自定义参数
// - 添加解析及处理分享链接接口
// - 添加关注模式下黑名单相关接口
// - 好友请求数据中添加对方富信息数据
// - 支持根据用户 ID 查找用户信息

// ### TapLogin
// #### Optimization and fixed bugs
// - 添加获取互关好友列表接口
// #### feat
// - 1111111
// `;

type StrictChangeType =
  | "breaking"
  | "feat"
  | "improvement"
  | "bugfix"
  | "internal";
const changeTypes: StrictChangeType[] = [
  "breaking",
  "feat",
  "bugfix",
  "improvement",
  "internal",
];
const changeTitle: Record<StrictChangeType, string> = {
  breaking: "Breaking changes",
  feat: "Features",
  improvement: "Improvements",
  bugfix: "Bug fixes",
  internal: "Internal changes",
};
type ChangeType = StrictChangeType | string;
interface Change {
  raw: string;
  module: string;
  type: ChangeType;
}

const typeMatchRules: [string, StrictChangeType][] = [
  ["break", "breaking"],
  ["feat", "feat"],
  ["bug", "bugfix"],
  ["fix", "bugfix"],
  ["internal", "internal"],
];
const matchType = (origin: string): StrictChangeType => {
  const lowercased = origin.toLocaleLowerCase();
  return (
    typeMatchRules.find(
      ([keyword]) => lowercased.indexOf(keyword) !== -1
    )?.[1] ?? "improvement"
  );
};

const moduleMatchRules: [string, string][] = [
  ["friend", "Friend"],
  ["firend", "Friend"],
  ["anti", "AntiAddiction"],
  ["防沉迷", "AntiAddiction"],
];
const matchModule = (origin: string): string => {
  const lowercased = origin.toLocaleLowerCase();
  return (
    moduleMatchRules.find(
      ([keyword]) => lowercased.indexOf(keyword) !== -1
    )?.[1] ?? origin
  );
};

const getScope = (module?: string) => (module ? `**${module}:** ` : "");
const getTitle = (type?: string) =>
  type ? `### ${changeTitle[type] ?? type}\n` : "";

const renderGroupedChanges = (changeLists: Record<ChangeType, Change[]>) => {
  const { breaking, feat, improvement, bugfix, internal, ...rests } =
    changeLists;
  return _.compact(
    [...changeTypes.filter((type) => changeLists[type]), ..._.keys(rests)].map(
      (type) => {
        const content = changeLists[type]
          ?.map(
            (change) =>
              `- ${getScope(change.module)}${change.raw.replaceAll(
                "\n",
                "\n  "
              )}\n`
          )
          .join("");
        return `${getTitle(
          type === "undefined" ? undefined : type
        )}${content}\n`;
      }
    )
  ).join("");
};

const parseMd = (md: string) => {
  const ast = marked.lexer(md);

  const descriptions: string[] = [];
  const changes: Change[] = [];
  let module: string;
  let type: ChangeType;

  let titleHoisted = false;

  // if the original notes starts with <!-- KEEP NOTES -->, keep it
  const [firstNode] = ast;
  if (
    firstNode &&
    firstNode.type === "html" &&
    firstNode.raw.startsWith("<!-- KEEP NOTES -->")
  ) {
    return {
      changes: [],
      descriptions: [md.replace("<!-- KEEP NOTES -->", "").trim()],
    };
  }

  ast.forEach((token) => {
    switch (token.type) {
      case "space":
        return;
      case "heading": {
        if (
          (token.depth === 2 &&
            (token.text.startsWith("Tap") || token.text.endsWith("SDK"))) ||
          (token.depth === 3 && !titleHoisted)
        ) {
          module = matchModule(
            token.text.replaceAll("SDK", "").replaceAll("Tap", "").trim()
          );
          if (token.depth === 2) {
            titleHoisted = true;
          }
        } else if (token.depth === 4 || (titleHoisted && token.depth === 3)) {
          type = matchType(token.text);
        } else {
          console.warn(
            "Ignoring unexpected heading depth",
            token.depth,
            token.raw
          );
        }
        return;
      }
      case "list": {
        changes.push(
          ...token.items.map((item) => ({
            raw: item.text,
            module,
            type,
          }))
        );
        return;
      }
      case "paragraph": {
        descriptions.push(token.raw);
        return;
      }
      default: {
        console.warn("Ignoring Unexpected token type", token.type, token.raw);
      }
    }
  });

  return { changes, descriptions };
};

const renderContent = ({
  changes,
  descriptions,
}: {
  changes: Change[];
  descriptions: string[];
}) => {
  const groupedChanges = _.groupBy(changes, "type");

  return [
    ...descriptions.map((d) => d + "\n"),
    renderGroupedChanges(groupedChanges),
  ].join("\n");
};

const renderRelease = (release: Release) => {
  const content = parseMd(
    release.body
      .replaceAll("\r\n", "\n")
      .replaceAll("【", "[")
      .replaceAll("】", "] ")
  );
  return `## ${release.tag_name}
Released ${release.published_at.slice(0, 10)}

${renderContent(content)}`;
};

getReleases().then((releases) => {
  console.log(releases.map(renderRelease).join("\n"));
  const contents = releases.map((release) =>
    parseMd(release.body.replaceAll("\r\n", "\n"))
  );

  console.log("-------------");
  console.log("Summary:");
  console.log(
    "Types",
    _.uniq(
      _.flatMap(
        contents.map(({ changes }) => changes.map((change) => change.type))
      )
    )
  );
  console.log(
    "Modules",
    _.uniq(
      _.flatMap(
        contents.map(({ changes }) => changes.map((change) => change.module))
      )
    )
  );
});
