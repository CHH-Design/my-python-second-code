# NJAU 选课助手

南京农业大学数字教务选课助手用户脚本，仅供本人账号使用。

## 运行环境

本脚本是 **Tampermonkey（篡改猴）** 用户脚本，需先在浏览器安装 Tampermonkey 扩展后才能运行。
支持 Chrome、Edge、Firefox 等带 Tampermonkey 的浏览器。

## 安装

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。
2. 在 Tampermonkey 中新建脚本，或直接打开 `njau-course-helper.user.js` 文件导入。
3. 打开 `https://szjw.njau.edu.cn/xkxzd/*` 页面，右下角会出现操作面板。

## 使用

修改脚本顶部的 `CFG.targets` 配置要抢的课程，然后在面板点「开始轮询」。