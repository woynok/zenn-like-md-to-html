'use strict';

import * as fs from "fs";
import * as path from 'path';
import { commands, ExtensionContext, TextDocument, Uri, window, workspace } from 'vscode';
import { format } from "prettier";
// import 'zenn-content-css';
import markdownToHtml from "zenn-markdown-html";

function isMdDocument(doc: TextDocument| undefined): boolean {
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

async function buildHtml(
  doc: TextDocument,
  fileNavigationHtml?: string,
  fileNavigationHtmlStyle?: string
): Promise<{ html: string }> {
    //// Determine document title.
    // find the first ATX heading, and use it as title
    let title = getDocumentTitle(doc);
    // Editors treat `\r\n`, `\n`, and `\r` as EOL.
    // Since we don't care about line numbers, a simple alternation is enough and slightly faster.
    // fileNavigationHtml は、ファイルナビゲーションのHTMLを入れる。もし、ない場合は、空文字列を入れる
    fileNavigationHtml = fileNavigationHtml || '<p>フォルダに対してレンダーをするとこの場所にナビゲーションバーが生成されます。</p>';
    fileNavigationHtmlStyle = fileNavigationHtmlStyle || '';

    // doc.getText()をもとに、サイドバーを作るため、目次を作成する
    let tocStringList = doc.getText().split(/\n|\r/g).filter(
        lineText => lineText.startsWith('#') && /^#{1,4} /.test(lineText)
    );
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
    
    let tocStyle = `
    <style>
      .toc {
        position: block;
        /* width: 400px; */
        top: 0;
        padding-left: 10px;
        padding-right: 10px;
        background-color: rgba(50, 120, 220, 0.15);
        border: 1px solid #eaecef;
        border-radius: 12px;
        margin: 0;
      }
      .toc li {
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }
      .toc > ul {
        padding: 4px;
        margin-top: 5px;
        margin-bottom: 5px;
      }
      .toc a {
        color: #272727;
        text-decoration: none;
      }
      /* hover されている、 li.toc-level-1以外 を opacity をつけて多段で色を付ける */
      .toc li:not(.toc-level-1):hover {
        background-color: rgba(0, 183, 255, 0.2);
      }
      .toc a:hover,
      .toc a:active {
        color: rgb(228, 42, 42);
      }
      .toc ul {
        list-style-type: none;
        padding: 4px;
      }
      .toc ul ul {
        padding-left: 12px;
      }
      .toc ul ul ul {
        padding-left: 12px;
      }
      .toc ul ul ul ul {
        padding-left: 12px;
      }
      .toc li.toc-level-3::before {
        content: "▷ ";
      }
      .toc li.toc-level-3:has(ul)::before {
        content: "▶ ";
        rotate: 0;
        transition: rotate 0.5s;
      }
      .toc li.toc-level-3:has(ul):hover::before,
      .toc li.toc-level-3:has(ul):active::before {
        content: "▼ ";
      }
      .toc li.toc-level-4 {
        display: list-item;
        height: 0;
        opacity: 0;
        transition: height 0.8s, opacity 0.8s;
      }
      .toc li.toc-level-3:hover li.toc-level-4,
      .toc li.toc-level-3:active li.toc-level-4 {
        display: list-item;
        height: 1.4em;
        opacity: 1;
        transition: height 0.3s, opacity 0.6s;
      }
      .toc li.toc-level-1 {
        font-size: 1.2em;
        font-weight: bold;
        margin-bottom: 3px;
      }
      .toc li.toc-level-2 {
        font-size: 0.8em;
        margin-bottom: 1px;
      }
      .toc li.toc-level-3 {
        font-size: 0.82em;
        margin-bottom: 1px;
      }
      .toc li.toc-level-4 {
        font-size: 0.9em;
        margin-bottom: 1px;
      }
    </style>
    `;
    let markdownText = doc.getText();
    // doc.getText()のimgの部分を先に修正する
    // ![text](uri) または、 ![text](uri =250x)のような形式のものを取り出す
    // さらに、uriはhttpやhttpsから始まらず、!は行頭であるものを取り出す
    let imgRegex = /!\[([^\]]*)\]\(([^)]+)(?:\s*=\s*(\d+)x(\d+))?\)/g;
    // imgRegex の 1番目は、alt text, 2番目は、uri, 3番目は、width
    let imgMatch;
    let imgSrcList = [];
    while ((imgMatch = imgRegex.exec(markdownText)) !== null) {
      let imgSrc = imgMatch[2];
      imgSrcList.push(imgSrc);
    }

    let rootDirectory = workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath || "";
    let thisDocDirectory = path.dirname(doc.uri.fsPath);
    for (let i = 0; i < imgSrcList.length; i++) {
        let imgSrc = imgSrcList[i];
        if (!imgSrc.startsWith('http://') && !imgSrc.startsWith('https://') && !imgSrc.startsWith('data:image/') && !imgSrc.startsWith('data:application/')) {
            // path が . で始まる場合は、directory からの相対パスとして扱う
            // path が / で始まる場合は、workspaceのrootからの絶対パスとして扱う
            // それ以外の場合は、directory からの相対パスとして扱う
            let imgRegexSearch = new RegExp(`!\\[([^\\]]*)\\]\\(${imgSrc}(?:\\s*.*)?\\)`, 'g');
            while ((imgMatch = imgRegexSearch.exec(markdownText)) !== null) {
                let imgString = imgMatch[0];
                let imgAlt = imgMatch[1];
                markdownText = markdownText.replace(imgString, `![${imgAlt}](./TOBE_BASE64_IMGPATH_${imgSrc}_TO_BE_BASE64_IMGPATH)`);
            }
        }
    }
    
    // 上記の画像uri
    
    let zennContent = markdownToHtml(markdownText, {
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
    let zennContentCss = fs.readFileSync(path.join(
        thisContext.extensionPath,
        'node_modules/zenn-content-css/lib/index.css'
    ),
    'utf-8').toString();

    let zennContentStyle = `<style>${zennContentCss}</style>`;
    let containerLayoutStyle = `
    <style>
      body {
        margin: 0;
        /* padding: 0; */
        font-family: "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
        font-size: 20px;
        line-height: 1.6;
        color: #333;
        background-color: #f4f4f4;
        /* width: 100vw; */
        /* width: 100cqw; */
        scroll-behavior: smooth;
      }

      body>div.container {
        width: 100%;
        margin-top: 0;
        margin-left: 0;
        margin-right: 0;
        padding: 0;
      }

      /* 980 px以下の一番小さいレイアウトでは、containerは縦積みで、file-navigationはheightが100pxで、doc-container内において、column-main-contentのみが表示されてcolumn-page-navigationはdisplay: none */

      body>div.container>div.file-navigation {
        display: block;
        width: 100%;
        height: 40px;
        background-color: #2e2525;
        color: #fff;
        padding: 0;
        position: sticky;
        top: 0;
        text-align: center;
        font-size: 0.8em;
        line-height: 40px;
        z-index: 12;
      }

      body>div.container>div.doc-container {
        width: 100%;
        margin: 8px;
        padding: 0;
      }

      body>div.container>div.doc-container>div.column-main-content {
        width: 100%;
        margin: 8px;
        padding: 0;
        /* font-size: 1.2em; */
      }

      body>div.container>div.doc-container>div.column-page-navigation {
        width: 100%;
        margin: 8px;
        padding: 0;
        display: none;
        /* font-size: 1.0em; */
      }

      body>div.container>div.doc-container>div.column-main-content div.znc h1>a,
      body>div.container>div.doc-container>div.column-main-content div.znc h2>a,
      body>div.container>div.doc-container>div.column-main-content div.znc h3>a,
      body>div.container>div.doc-container>div.column-main-content div.znc h4>a,
      body>div.container>div.doc-container>div.column-main-content div.znc h5>a,
      body>div.container>div.doc-container>div.column-main-content div.znc h6>a {
        pointer-events: none;
        cursor: default;
      }

      /* h2, h3, ... を sticky section titleにする */
      div.znc h2 {
        font-size: 1.1em;
        position: sticky;
        padding-left: 10px;
        /* background-color: rgb(192,192,192); */
        white-space: nowrap;
        background-color: #f4f4f4;
        top: 40px;
        height: 1em;
        display: flex;
        vertical-align: top;
        line-height: 1.4em;
        border-bottom: solid 1px rgb(156, 156, 156);
        box-shadow: 0 4px 4px -4px rgba(0, 0, 0, 0.5);
        z-index: 10;
      }

      div.znc h3 {
        font-size: 1em;
        padding-left: 15px;
        /* position: sticky; */
        /* background-color: #f4f4f4; */
        /* background-color: rgb(220, 220, 220); */
        /* border-bottom: solid 1px rgb(156, 156, 156); */
        /* box-shadow: 0 2px 2px -2px rgba(0, 0, 0, 0.1); */
        /* top: 1.4em; */
        /* height: 1.2em; */
        /* display: flex; */
        /* vertical-align: top; */
        line-height: 1.25em;
        z-index: 6;
      }

      div.znc h4 {
        font-size: 0.85em;
        padding-left: 20px;
        /* background-color: rgb(215,215,215); */
        /* display: flex;
          vertical-align: top; */
        line-height: 1.2em;
        z-index: 7;
      }

      /* div.znc h4 {
          font-size: 0.85em;
          position: sticky;
          padding-left:20px;
          background-color: rgb(235,235,235);
          top: 3.0em;
          height: 1.2em;
          display: flex;
          vertical-align: top;
          line-height: 1.2em;
          z-index: 7;
        } */

      div.znc h1>a::before,
      div.znc h2>a::before,
      div.znc h3>a::before,
      div.znc h4>a::before {
        content: " ";
        display: block;
        position: relative;
        width: 0;
        height: 40px;
        margin-top: -40px;
      }

      div.znc span.anchor-link {
        /* display: none; */
        position: absolute;
        transform: translateY(-40px);
      }

      body>div.container>div.file-navigation:has(input[type="checkbox"])>div.file-navigation-contents {
        visibility: hidden;
      }

      body>div.container>div.file-navigation:has(input[type="checkbox"]:checked)>div.file-navigation-contents {
        visibility: visible;
        background-color: #2e2525;
        z-index: 14;
        padding: 0.5em 0.2em;
      }

      body>div.container>div.file-navigation>div.file-navigation-switcher {
        /* 横に並べる。中央ぞろえ */
        display: flex;
        flex-direction: row;
      }

      body>div.container>div.file-navigation>div.file-navigation-switcher>.file-navigation-title {
        white-space: nowrap;
        width: fit-content;
        margin-left: 0.8em;
      }

      body>div.container>div.file-navigation>div.file-navigation-switcher span.file-navigation-remark {
        font-size: 0.8em;
        color: #d3d3d3;
        margin-left: 2.0em;
        line-height: 15px;
        display: inline-flex;
        top: -5px;
        position: relative;
      }

      #file-navigation-switch {
        display: none;
      }

      body>div.container>div.file-navigation>div.file-navigation-switcher {
        /* 横に並べる。中央ぞろえ */
        display: flex;
        flex-direction: row;
        /* justify-content: center; */
      }

      #file-navigation-switch~label {
        padding: 12px 12px;
        width: 40px;
        height: 40px;
        background: #2e2525;
        /* position: relative; */
        box-sizing: border-box;
        /* top: 0; */
        /* left: 5em; */
      }

      #file-navigation-switch~label span {
        /* display: flex; */
        width: 22px;
        height: 2px;
        top: 50%;
        left: 10px;
        /* right: 4em; */
        position: absolute;
        /* margin:auto; */
        /* line-height: 40px; */
        /* vertical-align: middle; */
        background: #fff;
        -webkit-transition: 0.2s transform;
        transition: 0.2s transform;
      }

      #file-navigation-switch~label span:before,
      #file-navigation-switch~label span:after {
        content: "";
        display: block;
        background: #fff;
        position: absolute;
        width: 22px;
        height: 2px;
        /* left: 0; */
        /* right: 0; */
        margin: auto;
      }

      #file-navigation-switch~label span:before {
        top: -9px;
      }

      #file-navigation-switch~label span:after {
        top: 9px;
      }

      #file-navigation-switch:checked~label span {
        -webkit-transform: rotate(-45deg);
        transform: rotate(-45deg);
      }

      #file-navigation-switch:checked~label span:before {
        top: 0;
      }

      #file-navigation-switch:checked~label span:after {
        -webkit-transform: rotate(270deg);
        transform: rotate(270deg);
        top: 0;
        margin-top: 0;
      }

      /* 次に大きい980px以上の場合は、div.column-page-navigationを横に置くために、do-containerをflexにする */

      @media screen and (min-width: 1200px) {
        body>div.container>div.doc-container {
          display: flex;
          flex-direction: row;
        }

        body>div.container>div.doc-container {
          display: flex;
          flex-direction: row;
          margin-left: 0;
          margin-right: 0;
          /* font-size: 0.8em; */
        }

        body>div.container>div.doc-container>div.column-main-content {
          width: 70%;
          /* font-size: 1.0em; */
        }

        body>div.container>div.doc-container>div.column-page-navigation {
          /* 合計してwidth 100%にしたときにはみでないようにする */
          /* 上にそもそも */
          max-width: 30%;
          position: sticky;
          top: 80px;
          padding: 0;
          margin: 0;
          height: 100vh;
          display: block;
          /* font-size: 0.8em; */
        }
      }

      /* さらに大きい、1200px以上の場合は、dv.containerもflexにしてfile-navigationを横並びにする */

      @media screen and (min-width: 1500px) {
        body>div.container {
          display: flex !important;
          flex-direction: row !important;
          /* 横方向にすべて使う */
          width: 100%;
          margin: 0;
        }

        body>div.container>div.file-navigation {
          /* min-width: 250px; */
          width: 16%;
          height: 100vh;
          display: block;
          position: sticky;
          top: 0;
          padding: 0;
          margin-right: 18px;
        }

        body>div.container>div.doc-container {
          width: 84%;
        }

        body>div.container>div.doc-container>div.column-main-content {
          width: 70%;
          max-width: 1500px;
          /* font-size: 1.1em; */
        }

        body>div.container>div.doc-container>div.column-page-navigation {
          width: 30%;
          /* width: fit-content; */
          /* font-size: 1.0em; */
        }

        div.znc h2 {
          font-size: 1.1em;
          position: sticky;
          padding-left: 10px;
          /* background-color: rgb(192,192,192); */
          white-space: nowrap;
          background-color: #f4f4f4;
          top: 0px;
          height: 1em;
          display: flex;
          vertical-align: top;
          line-height: 1.4em;
          border-bottom: solid 1px rgb(156, 156, 156);
          box-shadow: 0 4px 4px -4px rgba(0, 0, 0, 0.5);
          z-index: 10;
        }

        div.znc h1>a::before,
        div.znc h2>a::before,
        div.znc h3>a::before,
        div.znc h4>a::before
        {
          content: " ";
          display: block;
          position: relative;
          width: 0;
          height: 40px;
          margin-top: -40px;
        }

        div.znc span.anchor-link {
          /* display: none; */
          position: absolute;
          transform: translateY(-40px);
        }

        body>div.container>div.file-navigation:has(input[type="checkbox"])>div.file-navigation-contents {
          visibility: visible;
        }

        #file-navigation-switch {
          display: none;
        }

        #file-navigation-switch~label {
          display: none;
        }

        body>div.container>div.file-navigation>div.file-navigation-switcher {
          display: block;
        }

        body>div.container>div.file-navigation>div.file-navigation-switcher>span.file-navigation-title {
          margin-left: 1em;
          display: block;
          width: 100%;
          position: relative;
          padding: 0;
          height: 20px;
          line-height: 20px;
        }

        body>div.container>div.file-navigation>div.file-navigation-switcher>span.file-navigation-remark {
          font-size: 0.8em;
          color: #d3d3d3;
          margin-left: 0.5em;
          line-height: 17px;
          width: 90%;
          text-align: left;
          display: block;
          position: relative;
          padding: 0;
          /* bottom: 0; */
        }
      }
    </style>
    `;

    let zennContentStylePatch = `
    <style>
      div.container > div.doc-container > div.column-main-content div.znc details {
        font-size: 0.95em;
        margin: 1rem 0;
        line-height: 1.7;
      }
      div.container > div.doc-container > div.column-main-content div.znc summary {
        cursor: pointer;
        outline: 0;
        padding: 0.7em 0.7em 0.7em 0.9em;
        border: solid 1px #d6e3ed;
        color: var(--c-contrast);
        font-size: 0.9em;
        border-radius: 14px;
        background: #fff;
      }
      div.container > div.doc-container > div.column-main-content div.znc summary::-webkit-details-marker {
        color: #65717b;
      }

      div.container > div.doc-container > div.column-main-content div.znc details[open] > summary {
        border-radius: 14px 14px 0 0;
        box-shadow: none;
        background: #f1f5f9;
        border-bottom: none;
      }
      div.container > div.doc-container > div.column-main-content div.znc details > .details-content {
        border-radius: 14px;
        opacity: 0;
        transform: translateY(-20px);
        transition: opacity 0.5s ease-out, transform 0.3s ease-out;
      }
      div.container > div.doc-container > div.column-main-content div.znc details[open] > .details-content {
        padding: 0.5em 0.9em;
        border: solid 1px #d6e3ed;
        border-radius: 0 0 14px 14px;
        background: #fff;
        opacity: 1.0;
        transform: translateY(0);
        transition: opacity 0.5s ease-out, transform 0.3s ease-out;
      }
      div.container > div.doc-container > div.column-main-content div.znc .details-content > * {
        margin: 0.5em 0;
      }

      div.container div.column-main-content div.znc table {
        max-height: 70vh;
        overflow: auto;
      }
      /* first row as a sticky header */
      div.container div.column-main-content div.znc>table>thead>tr>th{
        position: sticky;
        top: -1px;
        z-index: 10;
        background-color: #bfd9f3!important;
        /* overflow-wrap: anywhere; */
        /* min-width: 150px; */
      }
      /* first column as a sticky column */
      div.container div.column-main-content div.znc table th:first-child,
      div.container div.column-main-content div.znc table td:first-child {
        position: sticky;
        left: -1px;
        background-color: #edf2f7;
      }
      
    </style>
    `;

    let zennHtml = `
        <!DOCTYPE html><html lang="ja">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <title>${title? title : ''}</title>
        ${fileNavigationHtmlStyle}
        ${containerLayoutStyle}
        ${tocStyle}
        ${zennContentStyle}
        ${zennContentStylePatch}
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
    let imgRegexForAddTitle = /<img src="([^"]+)" alt="([^"]+)"([^>]*)>/g;
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

    // この format がエラーでハングすることがあるので、タイムアウトを設けてエラー処理を入れる
    let html = zennHtml;
    try {
      let promiseHtml;
      promiseHtml = format(
          zennHtml,
          {
              parser: "html",
              printWidth: 260,
          }
      );
      html = await promiseHtml;
    } catch (e: any) {
        window.showWarningMessage('🐶 ' + title + ' をhtml化しましたが、htmlとしてparseできないhtmlになっています 🐶');
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
      return ;
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
    return ;
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
    return ;
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
        let title = getDocumentTitle(doc)|| 'Untitled';
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
        let folderObjectNext = {...folderObject.folderObjectList[i]};
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
    const fileNavigationHtmlStyle = `
    <style>
      div.file-navigation > div.file-navigation-contents {
        margin-left: 1.2em;
        margin-right: 0.8em;
      }
      div.file-navigation ul {
        list-style-type: none;
        padding: 0;
        margin-left: 1.2em;
        padding: 0.05em 0.1em;
        font-size: 0.9em;
      }
      div.file-navigation ul li {
        list-style-type: none;
        text-align: left;
      }
      div.file-navigation ul li > a {
        display: block;
        text-decoration: none;
        color: #333;
        margin: 0.15em 0.1em;
        padding: 0 0.5em;
        height: 1.8em;
        line-height: 1.5em;
        background-color: #f4f4f4;
        border-radius: 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      div.file-navigation ul li.folder > a {
        cursor: default;
        pointer-events: none;
      }

      div.file-navigation ul li.folder > a::before {
        content: "📁 ";
        margin-right: 0.5em;
      }
      div.file-navigation ul li.file > a::before {
        content: "📄 ";
        margin-right: 0.5em;
      }
      div.file-navigation li.file.active > a {
        background: linear-gradient(90deg, rgba(255, 255, 54, 1.0), rgba(255, 255, 109, 1.0), rgba(255, 255, 180, 1.0), #f4f4f4 100%);
      }
      div.file-navigation li.file.active > a::before {
        content: "📄🌟 ";
        margin-right: 0.5em;
      }
    </style>
    `;
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
