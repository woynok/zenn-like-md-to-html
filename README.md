# zenn-like-md-to-html README

## 1. 概要

### 1.1. English

Zenn's markdown notation is great. Furthermore, they have published CLI, css, and renderer under the MIT license. It is wonderful.

This tool is a tool that converts a markdown file using the notation often used in zenn into a single page (html file) by pressing `ctrl` + `shift` + `alt` + `p`.

Also, by pressing `ctrl` + `shift` + `alt` + `d`, you can convert the markdown files in the entire workspace to html files with the same name (be careful because it will be overwritten).
When converting markdown files in the entire workspace, the folder structure of the workspace is output as an html file as a file navigation.

This conversion tool is styled as much as possible with css so that it can be displayed even in an environment where javascript cannot be used.
I would like to make it a little more stylish in the future.

### 1.2. Japanese

Zennのmarkdown記法はすばらしい。さらに彼らはCLIやcssやrendererをMITライセンスで公開している。これは素晴らしいことだ。

このツールは、zennでよく使われる記法が使われたmarkdownファイルを`ctrl` + `shift` + `alt` + `p`で一つのページ (htmlファイル) に変換するツールです。

また、`ctrl` + `shift` + `alt` + `d`を押すことで、workspace全体のmarkdownファイルを同名のhtmlファイルに変換することもできます(上書きされるので注意)。
workspace全体のmarkdownファイルを変換した際には、workspaceのフォルダ構造がfile-navigationとしてhtmlファイルに出力されます。

この変換ツールは、javascriptが使えない環境でも表示されるようにできる限りcssでスタイリングしています。
また、画像がhtmlに埋め込まれるようにしています。
いずれは、もう少しカスタマイズ可能なスタイリッシュなものにしたいと思います。

## 2. applicable markdown notation

### 2.1. working as expected

- call out
- code block (with tag)
- accordion
- table
  - table header, the first table column is to be sticky

## 3. not working unexpectedly

- link card (need script)
  - please use `[xxx](yyy)` notation
- mathematical formula
