'use strict';

import * as fs from "fs";
import * as path from 'path';
import { commands, ExtensionContext, TextDocument, Uri, window, workspace } from 'vscode';
import { format } from "prettier";
// import 'zenn-content-css';
import markdownToHtml from "zenn-markdown-html";

function isMdDocument(doc: TextDocument | undefined): boolean {
  if (!doc) {
    return false;
  }
  const extraLangIds = workspace.getConfiguration('zenn-like-md-to-html').get<string[]>('extraLangIds') || [];
  const langIds = ['markdown', 'md', ...extraLangIds];
  return langIds.includes(doc.languageId);
}


let thisContext: ExtensionContext;

function getDocumentTitle(doc?: TextDocument): string | undefined {
  // find the first ATX heading, and use it as title
  if (!doc) {
    return undefined;
  }
  let title = doc.getText().split(/\n|\r/g).find(lineText => lineText.startsWith('#') && /^#{1,6} /.test(lineText));
  if (title) {
    title = title.replace(/<!--(.*?)-->/g, '');
    title = title.trim().replace(/^#+/, '').replace(/#+$/, '').trim();
  } else {
    title = 'Untitled';
  }
  return title;
}

class markdownBlock {
  text: string;
  // blockType は、'plain', 'code', 'callout'
  type: string;
  constructor(text: string, type: string) {
    this.text = text;
    this.type = type;
  }
}


async function buildHtml(
  doc: TextDocument,
  fileNavigationHtml?: string,
  fileNavigationHtmlStyle?: string
): Promise<{ html: string }> {
  //// Determine document title.
  // find the first ATX heading, and use it as title
  let title = getDocumentTitle(doc);
  let markdownText = doc.getText();
  // Editors treat `\r\n`, `\n`, and `\r` as EOL.
  // Since we don't care about line numbers, a simple alternation is enough and slightly faster.
  // fileNavigationHtml は、ファイルナビゲーションのHTMLを入れる。もし、ない場合は、空文字列を入れる
  fileNavigationHtml = fileNavigationHtml || '<p>フォルダに対してレンダーをするとこの場所にナビゲーションバーが生成されます。</p>';
  fileNavigationHtmlStyle = fileNavigationHtmlStyle || '';

  // doc.getText()をもとに、サイドバーを作るため、目次を作成する
  // 下記の方法では、``` で囲まれたコードブロック内の # は、目次に含まれてしまうので、最初にコードブロックを取り除く
  // TODO: この処理も改善の余地がある。BlockListを階層構造にしてネスト構造を考慮して実施が必要
  let markdownTextWithoutCodeBlock = markdownText.replace(/^```[\s\S]*?```/g, '');
  markdownTextWithoutCodeBlock = markdownTextWithoutCodeBlock.replace(/^:::[\s\S]*?:::/g, '');

  // h2 以下の見出しを取り出す
  let tocStringList = markdownTextWithoutCodeBlock.split(/\n|\r/g).filter(
    lineText => /^#{2,6} /.test(lineText)
  );
  // tocStringList に、ただひとつの title をもたせるために、先頭に `# ${title}` を追加する
  tocStringList.unshift(`# ${title}`);
  // tocStringList は flatな構造なので、それを階層構造に変換する
  let tocString: any[] = [];
  let tocStack: any[] = [];
  if (tocStringList.length <= 2) {
    tocStack = [];
    tocString = [];
  } else {
    for (let i = 0; i < tocStringList.length; i++) {
      let header = tocStringList[i];
      let headerLevel = header.match(/^#+/)?.[0].length || 0;
      let headerText = header.replace(/^#+/, '').replace(/#+$/, '').trim();
      let headerId = headerText.replace(/ /g, '-').toLowerCase();
      // remove backtick from headerIdEncoded
      let headerIdEncoded = encodeURIComponent(headerId.replace(/`/g, ''));
      let headerObject = {
        header: header,
        headerLevel: headerLevel,
        headerText: headerText,
        headerId: headerId,
        headerIdEncoded: headerIdEncoded,
        children: []
      };
      if (headerLevel === 1) {
        tocString.push(headerObject);
        tocStack = [headerObject];
      } else {
        // h1のATX header がないと、tocStack[headerLevel - 2] が存在しないので、エラーになる
        // そこで、tocStackの長さが足りないときは、returnする
        let parent = tocStack[headerLevel - 2];
        parent.children.push(headerObject);
        tocStack[headerLevel - 1] = headerObject;
      }
    }
  }
  // tocString を再帰的に処理して、目次のHTMLを作成する
  let tocLevel = 1;
  let tocBody = (tocObject: any) => {
    // let tocHtmlString = `<li class="toc-level-${tocLevel}"><a href="#${tocObject.headerIdEncoded}">${tocObject.headerText}</a>`;
    // alt text に header を入れる
    let tocHtmlString = `<li class="toc-level-${tocLevel}"><a href="#${tocObject.headerIdEncoded}" title="${tocObject.header}">${tocObject.headerText}</a>`;
    if (tocObject.children.length > 0) {
      tocLevel++;
      tocHtmlString += '<ul>';
      for (let i = 0; i < tocObject.children.length; i++) {
        tocHtmlString += tocBody(tocObject.children[i]);
      }
      tocLevel--;
      tocHtmlString += '</ul>';
    }
    tocHtmlString += '</li>';
    return tocHtmlString;
  };
  let tocHtmlString = '';
  for (let i = 0; i < tocString.length; i++) {
    tocHtmlString += tocBody(tocString[i]);
  }

  let tocHtml = `
    <div class="toc">
        <ul>
            ${tocHtmlString}
        </ul>
    </div>
    `;

  // doc.getText()のimgの部分を先に修正する
  // ![text](uri) または、 ![text](uri =250x)のような形式のものを取り出す
  // さらに、uriはhttpやhttpsから始まらず、!は行頭であるものを取り出す

  // block内は、終端が見れるまではgreedy matchではなく、 non-greedy match にする。始端と終端は同じ記号である必要がある
  let codeBlockRegex = /(:{3,}|`{3,})(?:(.*$)\n)?([\s\S]*?)(?:(?:\n\1)|$)/m;
  // ネスト構造をいずれ、処理したい。

  // まずは、 markdownTextのうち、```に囲まれていたり、:::に囲まれていたりするcode block に該当しない各部分を取り出して、whileで回す
  // そのためには、markdownTextのCode Block部分に該当するたびに、そこまでのテキストと、そのテキストがCode Blockであるかどうかを記録しておく
  let markdownBlockList: markdownBlock[] = [];
  let markdownTextTarget = markdownText;
  let markdownBlockType = 'unknown';
  let markdownBlockMatch;
  while ((markdownBlockMatch = codeBlockRegex.exec(markdownTextTarget)) !== null) {
    // 先頭から初めてmatchしたところまでの部分は、plain text、matchした部分は、code block
    let plainText = markdownTextTarget.slice(0, markdownBlockMatch.index);
    markdownBlockList.push(new markdownBlock(plainText, 'plain'));
    let codeBlock = markdownBlockMatch[0];
    // codeBlock が ``` で始まるか、::: で始まるかで、code block の種類を判定する
    if (codeBlock.startsWith('```')) {
      markdownBlockType = 'code';
    } else if (codeBlock.startsWith(':::')) {
      markdownBlockType = 'callout';
    } else {
      markdownBlockType = 'unknown';
    }
    markdownBlockList.push(new markdownBlock(codeBlock, markdownBlockType));
    markdownTextTarget = markdownTextTarget.slice(markdownBlockMatch.index + codeBlock.length);
  }
  // 次に、plain textまたはcalloutの部分のみ、![]() を取り出す。ただし、inline code block内には、![]() があっても、画像ではないので、無視する
  let imgRegex = /^!\[([^\]]*)\]\((?!\.\/TOBE_BASE64_IMGPATH_)([^)]+)(?:\s*=\s*(\d+)x(\d+))?\)$/gm;
  
  let imgSrcList: string[] = [];
  // imgRegex の 1番目は、alt text, 2番目は、uri, 3番目は、width
  let imgMatch;
  for (let i = 0; i < markdownBlockList.length; i++) {
    let markdownBlock = markdownBlockList[i];
    if (markdownBlock.type === 'plain' || markdownBlock.type === 'callout') {
      let markdownTextTarget = markdownBlock.text;
      while ((imgMatch = imgRegex.exec(markdownTextTarget)) !== null) {
        let imgSrc = imgMatch[2];
        let imgAlt = imgMatch[1];
        // もし、http:// または https:// で始まらない場合
        if (!imgSrc.startsWith('http://') && !imgSrc.startsWith('https://') && !imgSrc.startsWith('data:image/') && !imgSrc.startsWith('data:application/')) {
          let imgReplaced = `![${imgAlt}](./TOBE_BASE64_IMGPATH_${imgSrc}_TO_BE_BASE64_IMGPATH)`;
          markdownBlockList[i].text = markdownBlockList[i].text.slice(0, imgMatch.index) + imgReplaced + markdownBlockList[i].text.slice(imgMatch.index + imgMatch[0].length);
          // markdownの状態でdataを入れるとrendererの処理が重いので、いったんマーキングだけして、後で置き換える
          imgSrcList.push(imgSrc);
          markdownTextTarget = markdownTextTarget.slice(0, imgMatch.index) + imgReplaced + markdownTextTarget.slice(imgMatch.index + imgMatch[0].length);
        }
      }
    }
  }

  let rootDirectory = workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath || "";
  let thisDocDirectory = path.dirname(doc.uri.fsPath);
  // markdownBlockList を使って、markdownTextを再構築する
  let markdownTextReconstructed = '';
  for (let i = 0; i < markdownBlockList.length; i++) {
    markdownTextReconstructed += markdownBlockList[i].text;
  }

  let zennContent = markdownToHtml(markdownTextReconstructed, {
    embedOrigin: "https://embed.zenn.studio",
  });
  // .* src="./TOBE_BASE64_IMGPATH_${imgPath}_TO_BE_BASE64_IMGPATH" を見つけて、imgPathを取得し、src="data:image/ext;base64,..." に置き換える
  // 行頭とは限らない
  for (let i = 0; i < imgSrcList.length; i++) {
    let imgSrc = imgSrcList[i];
    let imgPath = '';
    if (imgSrc.startsWith('.')) {
      imgPath = path.join(thisDocDirectory, imgSrc);
    } else if (imgSrc.startsWith('/')) {
      imgPath = path.join(rootDirectory, imgSrc);
    } else {
      imgPath = path.join(thisDocDirectory, imgSrc);
    }
    // 場合によっては、imgData = fs.readFileSync(imgPath);が失敗することもあるので、try-catchで囲む
    let imgData: Buffer;
    try {
      imgData = fs.readFileSync(imgPath);
    } catch (e) {
      window.showWarningMessage('🐶 ' + title + ' の画像 ' + imgPath + ' が読み込めませんでした 🐶');
      continue;
    }
    let imgExt = path.extname(imgPath).replace(/^\./, '');
    let imgBase64 = imgData.toString('base64');
    let imgBase64String = `src="data:image/${imgExt};base64,${imgBase64}"`;
    zennContent = zennContent.replace(`src="./TOBE_BASE64_IMGPATH_${imgSrc}_TO_BE_BASE64_IMGPATH"`, imgBase64String);
  }

  zennContent = `<div class="znc">${zennContent}</div>`;
  const zennContentCss = fs.readFileSync(path.join(
    thisContext.extensionPath,
    'node_modules/zenn-content-css/lib/index.css'
  ),
    'utf-8').toString();
  let zennContentStyle = `<style>${zennContentCss}</style>`;
  const assetPath = path.join(thisContext.extensionPath, 'asset');
  const tocStyle = fs.readFileSync(path.join(assetPath, 'toc-style.html'), 'utf8');
  const containerLayoutStyle = fs.readFileSync(path.join(assetPath, 'container-layout-style.html'), 'utf8');
  const zennPatchStyle = fs.readFileSync(path.join(assetPath, 'zenn-patch-style.html'), 'utf8');

  let zennHtml = `
        <!DOCTYPE html><html lang="ja">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <title>${title ? title : ''}</title>
        ${fileNavigationHtmlStyle}
        ${containerLayoutStyle}
        ${tocStyle}
        ${zennContentStyle}
        ${zennPatchStyle}
        <!-- <script src="https://embed.zenn.studio/js/listen-embed-event.js"></script> -->
        </head>
        <body>
        <div class="container">
            <div class="file-navigation">
              ${fileNavigationHtml}
            </div>
            <div class="doc-container">
              <div class="column-main-content">
                  ${zennContent}
              </div>
              <div class="column-page-navigation">
                  ${tocHtml}
              </div>
            </div>
        </div>
        </body></html>`
    ;

  // <img src="..." alt="..." ... /> のようになっているものについて、alt textをtitleに入れる
  let imgRegexForAddTitle = /<img src="([^"]+?)" alt="([^"]+?)"([^>]*?)>/g;
  let imgMatchForAddTitle;
  while ((imgMatchForAddTitle = imgRegexForAddTitle.exec(zennHtml)) !== null) {
    let imgString = imgMatchForAddTitle[0];
    let imgSrc = imgMatchForAddTitle[1];
    let imgAlt = imgMatchForAddTitle[2];
    let imgTitle = imgAlt;
    let imgStringWithTitle = `<img src="${imgSrc}" alt="${imgAlt}" title="${imgTitle}"${imgMatchForAddTitle[3]}>`;
    zennHtml = zennHtml.replace(imgString, imgStringWithTitle);
  }

  // <sup class="footnote-ref"><a href="#fn-e546-1" id="fnref-e546-1">[1]</a></sup>
  // となっているものがあるので、このid部分のみを消し、上部に<span class="anchor-link" id="fn-e546-1"></span>を追加する
  // つまり<span class="anchor-link" id="fn-e546-1"></span><sup class="footnote-ref"><a href="#fn-e546-1">[1]</a></sup>に変更する
  let footnoteRegex = /<sup class="footnote-ref"><a href="#fn-([^"]+)" id="fnref-[^"]+"[^>]*>(\[\d+\])<\/a><\/sup>/g;
  let footnoteMatch;
  while ((footnoteMatch = footnoteRegex.exec(zennHtml)) !== null) {
    let footnoteString = footnoteMatch[0];
    let footnoteId = footnoteMatch[1];
    let footnoteNumber = footnoteMatch[2];
    let footnoteSupString = `<sup class="footnote-ref"><a href="#fn-${footnoteId}">${footnoteNumber}</a></sup>`;
    let footnoteStringWithAnchor = `<span class="anchor-link" id="fnref-${footnoteId}"></span>${footnoteSupString}`;
    zennHtml = zennHtml.replace(footnoteString, footnoteStringWithAnchor);
  }

  // この format がエラーでハングすることがあるので、try catch で囲む
  let html = zennHtml;
  try {
    let promiseHtml;
    promiseHtml = format(
      zennHtml,
      {
        parser: "html",
        printWidth: 260,
        endOfLine: "auto",
      }
    );
    html = await promiseHtml;
  } catch (e: any) {
    // let warningMessage = '🐶 ' + title + ' をhtml化しましたが、htmlとしてparseできないhtmlになっています 🐶' + '\n\n' + e.message;
    // これだと、ansi escape codeがそのまま表示されてしまうので、それを取り除く
    let warningMessage = '🐶 ' + title + ' をhtml化しましたが、htmlとしてparseできないhtmlになっています 🐶' + '\n\n' + e.message.replace(/\u001b\[\d+m/g, '');
    window.showWarningMessage(warningMessage);
    html = zennHtml;
  }
  // writeFile せずに、 outPath, html, title を返す
  return { html };
}

async function exportPage(uri?: Uri, outFolder?: string, showNotification?: boolean) {
  showNotification = showNotification === undefined ? true : showNotification;
  const editor = window.activeTextEditor;

  if (!editor || !isMdDocument(editor?.document)) {
    window.showErrorMessage("マークダウンドキュメントを開き、選択して実行してください。");
    return;
  }

  const doc = uri ? await workspace.openTextDocument(uri) : editor.document;
  if (doc.isDirty || doc.isUntitled) {
    doc.save();
  }

  const statusBarMessage = window.setStatusBarMessage("$(sync~spin) " + "markdownをhtmlに変換中…");

  if (outFolder && !fs.existsSync(outFolder)) {
    fs.mkdirSync(outFolder, { recursive: true });
  }

  /**
   * Modified from <https://github.com/Microsoft/vscode/tree/master/extensions/markdown>
   * src/previewContentProvider MDDocumentContentProvider provideTextDocumentContent
   */
  let outPath = outFolder ? path.join(outFolder, path.basename(doc.fileName)) : doc.fileName;
  outPath = outPath.replace(/\.\w+?$/, '.html');
  outPath = outPath.replace(/^([cdefghij]):\\/, function (_, p1: string) {
    return `${p1.toUpperCase()}:\\`; // Capitalize drive letter
  });
  if (!outPath.endsWith('.html')) {
    outPath += '.html';
  }
  buildHtml(doc).then(
    ({ html }) => {
      let title = getDocumentTitle(doc) || 'Untitled';
      fs.writeFile(outPath, html, 'utf8', (err) => {
        let message = '';
        if (err) {
          message = '🐶 ' + title + ' のhtml化に失敗しました 🐶';
          if (showNotification) {
            window.showErrorMessage(message);
            setTimeout(() => statusBarMessage.dispose(), 400);
          }
        }
        message = '🐶 ' + title + ' をhtml化しました 🐶';
        if (showNotification) {
          window.showInformationMessage(message);
          setTimeout(() => statusBarMessage.dispose(), 400);
        }
      }
      );
    }
  );
}

// folderObjectのクラスを作成する
class FileObject {
  fileName: string;
  title: string;
  filePath: string;
  constructor(fileName: string, title: string, filePath: string) {
    this.fileName = fileName;
    this.title = title;
    this.filePath = filePath;
  }
}
class FolderObject {
  folderPath: string;
  folderName: string;
  folderNameAlias: string;
  folderObjectList: FolderObject[];
  fileObjectList: FileObject[];
  constructor(folderPath: string, folderName: string, folderNameAlias: string, folderObjectList: FolderObject[], fileObjectList: FileObject[]) {
    this.folderPath = folderPath;
    this.folderName = folderName;
    this.folderNameAlias = folderNameAlias;
    this.folderObjectList = folderObjectList;
    this.fileObjectList = fileObjectList;
  }
}

// function exportWorkspace
async function exportWorkspace(uri?: Uri, outFolder?: string) {
  // workspace 状の markdownファイルをすべて取得し、フォルダ構成からfile-navigationのhtmlを作成し、それを使って、各markdownファイルをhtmlに変換する
  // また、root に html_configuration.json がある場合は、それを使って、フォルダ名を変更する

  const editor = window.activeTextEditor;
  // workspaceのrootPath
  const rootPath = workspace.workspaceFolders?.[0].uri.fsPath;
  // もし、rootpath がない場合は、エラーを出して終了する
  if (!rootPath) {
    window.showErrorMessage("🐶 workspace が開かれていません 🐶");
    return;
  }
  // ここから先は、すべてrootPath配下のみの処理となる

  // markdownのファイルパスのリストを取得する
  let markdownFileList: string[] = [];
  // root配下のファイルを再帰的に取得する
  const getFiles = (dir: string) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        getFiles(filePath);
      } else if (stat.isFile() && filePath.endsWith('.md')) {
        markdownFileList.push(filePath);
      }
    }
  };
  getFiles(rootPath);
  // markdownFileList が空の場合は、エラーを出して終了する
  if (markdownFileList.length === 0) {
    window.showErrorMessage("🐶 markdownファイルが見つかりません 🐶");
    return;
  }
  // markdownFileList がある場合は、それを使って、各markdownごとにfile-navigation.htmlの中身を作成し、buildHtmlを使ってhtmlに変換していく
  // 各markdownのhtmlから見ての相対パスをhrefに入れる
  // folderにはhrefはいれない。folderAliasをテキストにする。folderAliasは、rootPathからの相対パスを使って作成する
  // markdownFileListをソートして実行し、directory構造をリストのリストとして表現する
  markdownFileList.sort();
  // rootPathからの相対パスを使って、folderObjectを作成する
  let folderObject = new FolderObject('', path.basename(rootPath), 'root', [], []);
  // markdownFileListを使って、folderObjectを作成する
  for (let i = 0; i < markdownFileList.length; i++) {
    let markdownFilePath = path.relative(rootPath, markdownFileList[i]);
    let markdownFilePathList = markdownFilePath.split(path.sep);
    let folderObjectPointer = folderObject;
    for (let j = 0; j < markdownFilePathList.length; j++) {
      // folderObjectのfolderObjectListに、folderPathがmarkdownFilePathList[j]であるものがあるかどうかを探し、なければ作成する
      // j = markdownFilePathList.length - 1 のときは、fileObjectを作成する
      if (j === markdownFilePathList.length - 1) {
        // fileObjectを作成して、folderObjectPointerのfileObjectListに追加する
        let fileName = path.basename(markdownFilePath);
        let doc = await workspace.openTextDocument(markdownFileList[i]);
        let title = getDocumentTitle(doc) || 'Untitled';
        let fileObject = new FileObject(fileName, title, markdownFilePath);
        folderObjectPointer.fileObjectList.push(fileObject);
        break;
      } else {
        let folderName = markdownFilePathList[j];
        let folderObjectList = folderObjectPointer.folderObjectList;
        let folderObject = folderObjectList.find((folderObject: any) => folderObject.folderName === folderName);
        if (!folderObject) {
          let folderPath = path.join(folderObjectPointer.folderPath, folderName);
          let folderNameAlias = folderName;
          folderObject = new FolderObject(folderPath, folderName, folderNameAlias, [], []);
          folderObjectList.push(folderObject);
        }
        folderObjectPointer = folderObject;
      }
    }
  }


  // folderObjectを使って、fileNavigationHtmlを各markdownごとに作成しつつ、buildしていく。markdownごとに異なるのは、hrefと、liのactiveかどうか
  // fileNavigationHtmlは、rootPathから見てfolderに入るごとに ul が増え、ファイルが増えるごとに li が増える
  // folderのストラクチャはすでにパース済みなので、各markdownファイルごとに、そのファイルパスを与えたらfileNavigationHtmlは次のような関数で作成することができる
  // hrefを相対パスにして、さらに自分自身のファイルパスが属するul, liをactiveにすることを忘れずにおこなう
  // この fileNavigationHtmlFactoryができれば、各markdownファイルごとに、buildHtmlを使ってhtmlに変換することができる

  const fileNavigationHtmlFactory = (folderObject: FolderObject, relativeTargetFilePath: string) => {
    // 各ファイルの捜索をしていく、folderObject.fileObjectListを見て、なければfolderObject.folderObjectListを見て、それもなければ停止する
    // fileObjectListがあれば、各ファイルについて、htmlのliを作成する
    // folderObjectListがあれば、各フォルダについて、htmlのliを作成し、ulを追加したうえで中に入る
    // これを再帰的に行う
    // 再帰的に行う関数を先に定義する。
    const recursiveFileNavigationHtmlFactory = (folderObject: FolderObject, relativeTargetFilePath: string, fileNavigationHtmlString: string) => {
      // input の folderObjectについてはもう探査の必要がない状態にして、次の階層のfolderObjectNextと、relativeTargetFilePathとfileNavigationHtmlStringを返す
      // まずは、folderObjectのfileObjectListを見ていく
      let fileObjectList = folderObject.fileObjectList;
      if (fileObjectList.length > 0) {
        for (let i = 0; i < fileObjectList.length; i++) {
          let fileObject = fileObjectList[i];
          let fileName = fileObject.fileName;
          let fileTitle = fileObject.title;
          let fileHref = path.relative(path.dirname(relativeTargetFilePath), fileObject.filePath).replace(/\\/g, '/').replace(/\.md$/, '.html');
          let fileNavigationHtmlStringFile = '';
          if (relativeTargetFilePath === fileObject.filePath) {
            fileNavigationHtmlStringFile = `<li class="file active"><a href="${fileHref}">${fileTitle}</a></li>`;
          } else {
            fileNavigationHtmlStringFile = `<li class="file"><a href="${fileHref}">${fileTitle}</a></li>`;
          }
          fileNavigationHtmlString += fileNavigationHtmlStringFile;
        }
      }
      // 次に、folderObjectのfolderObjectListを見て再帰的に探査する
      let relativeTargetFolderPath = path.dirname(relativeTargetFilePath);
      for (let i = 0; i < folderObject.folderObjectList.length; i++) {
        let folderObjectNext = { ...folderObject.folderObjectList[i] };
        let folderHref = path.relative(path.dirname(relativeTargetFilePath), folderObjectNext.folderPath);
        if (folderObjectNext.folderPath === relativeTargetFolderPath) {
          fileNavigationHtmlString += `<li class="folder active"><a href="${folderHref}">${folderObjectNext.folderNameAlias}</a>`;
        } else {
          fileNavigationHtmlString += `<li class="folder"><a href="${folderHref}">${folderObjectNext.folderNameAlias}</a>`;
        }
        // ul を付けて、次の探査
        fileNavigationHtmlString += '<ul>';
        // input の folderObjectについてはもう探査の必要がない状態にして、次の階層のfolderObjectNextと、relativeTargetFilePathとfileNavigationHtmlStringを返す
        let fileNavigationHtmlStringNext = '';

        fileNavigationHtmlStringNext = recursiveFileNavigationHtmlFactory(folderObjectNext, relativeTargetFilePath, fileNavigationHtmlStringNext);
        fileNavigationHtmlString += fileNavigationHtmlStringNext;
        fileNavigationHtmlString += '</ul>';
        fileNavigationHtmlString += '</li>';
      }
      return fileNavigationHtmlString;
    };
    // ここから、fileNavigationHtmlFactoryの本体
    let fileNavigationHtmlString = '';
    fileNavigationHtmlString = recursiveFileNavigationHtmlFactory(folderObject, relativeTargetFilePath, fileNavigationHtmlString);
    fileNavigationHtmlString = `
    <div class="file-navigation-switcher">
      <input type="checkbox" id="file-navigation-switch" />
      <label for="file-navigation-switch"><p><span></span></p></label>
      <div class="file-navigation-title">ドキュメント</div>
      <span class="file-navigation-remark"><p>このURLは指定のSharepointサイトを同期して、フォルダ内のhtmlファイルをダブルクリックして開く想定です。</p></span>
    </div>
    <div class="file-navigation-contents">
      <ul>
        ${fileNavigationHtmlString}
      </ul>
    </div>
    `;
    return fileNavigationHtmlString;
  };

  // buildHtmlを使って、htmlに変換する
  for (let i = 0; i < markdownFileList.length; i++) {
    let markdownFilePath = markdownFileList[i];
    let markdownRelativePath = path.relative(rootPath, markdownFilePath);
    let markdownFileName = path.basename(markdownFilePath);
    let fileNavigationHtml = fileNavigationHtmlFactory(folderObject, markdownRelativePath);
    let doc = await workspace.openTextDocument(markdownFilePath);
    let title = getDocumentTitle(doc) || 'Untitled';
    let outPath = outFolder ? path.join(outFolder, path.basename(markdownFilePath)) : markdownFilePath;
    outPath = outPath.replace(/\.\w+?$/, '.html');
    // if (doc.isDirty || doc.isUntitled) {
    //     doc.save();
    // }
    // const fileNavigationHtmlStyle として、 asset/file-navigation-style.html を使う
    
    const assetPath = path.join(thisContext.extensionPath, 'asset');
    const fileNavigationHtmlStyle = fs.readFileSync(path.join(assetPath, 'file-navigation-style.html'), 'utf8');  
    buildHtml(doc, fileNavigationHtml, fileNavigationHtmlStyle).then(
      ({ html }) => {
        fs.writeFile(outPath, html, 'utf8', (err) => {
          title = getDocumentTitle(doc) || 'Untitled';
          if (err) {
            window.showErrorMessage('🐶 ' + title + ' のhtml化に失敗しました 🐶');
            return;
          }
          window.showInformationMessage('🐶 ' + title + ' をhtml化しました 🐶');
        }
        );
      }
    );
  }
}

export function activate(context: ExtensionContext) {
  thisContext = context;
  context.subscriptions.push(
    commands.registerCommand('zenn-like-md-to-html.exportPage', () => { exportPage(); }),
    commands.registerCommand('zenn-like-md-to-html.exportWorkspace', () => { exportWorkspace(); }),
  );
}

export function deactivate() { }
