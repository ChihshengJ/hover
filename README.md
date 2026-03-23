<p align="center">
  <img src="assets/IMG_3047.png" width="140" alt="Hover Banner"/>
</p>

<h1 align="center">Hover — An immersive PDF Reader</h1>

<p align="center">
    <a href="https://chromewebstore.google.com/detail/cpnjpgkmfmdnfaonlhmfaalojnilnilg?utm_source=item-share-cb" target="_blank">
        <img src="assets/CWS.png" width="145" alt="Chrome Web Store link"/>
    </a>
    &nbsp;&nbsp;&nbsp;
    <a href="https://chihshengj.github.io/hover-pdf/demo/" target="_blank">
        <img src="https://img.shields.io/badge/▶%20Live%20Demo-FFFFFF?style=for-the-badge&logo=googlechrome" height="32" alt="Live Demo"/>
    </a>
</p>

Hover is a minimalist PDF reader designed for people who spend way too much time reading academic papers **in the browser**.

It intentionally keeps only the most essential reading features, but aims to make the experience of reading papers smoother, faster, and more immersive
by introducing a **carefully designed UI system** for desktop reading based on a single ball-shaped controller.
Every action and command revolves around the single controller, and everything irrelevant to reading fades into the background.

The project is built with Vanilla JS and is dependent on [Embed PDF](https://www.embedpdf.com/)'s engine and Pdfium.

<small>\*A significant portion of the codebase was developed with AI assistance; however, the author has 100% audited the code.</small>

---

## Features

### 1. Inline Citation Preview

The main goal of creating Hover is to solve the problem of LaTeX citation links that direct you straight to the references when reading most STEM papers.
Hover solves this problem by searching the nearest reference based on the coordinates linked to the citation.

Just hover your mouse on the citation link, the content of the citation would appear right at the spot.
You can even directly open up the URL in the citation or check out the abstract of the paper extracted from Google Scholar.

| Actual reference                                | Google Scholar Abstract                         |
| ----------------------------------------------- | ----------------------------------------------- |
| ![cite_preview1](assets/citation_preview_1.png) | ![cite_preview2](assets/citation_preview_2.png) |

### 2. Innovative Navigation System

<br>
<p align="center">
    <strong>PDF readers are boring as hell.</strong>
</p>
<br>

Hover introduces a compact yet beautifully designed navigation system that works just like magic.
It all starts with a ball:

<p align="center">
<img src="assets/ball_demo.png" width="120" alt="Hover Banner"/>
</p>

- **Left-click**: open the full mini toolbar which includes **rotate**, **split window**, **spread mode**, **fit screen**, and **zoom in/out**.

<p align="center">
<img src="assets/ball_expand.gif" width="90" alt="Hover Banner"/>
</p>

- **Double-click**: go to top
- **Drag it vertically**: scroll the document
<p align="center">
<img src="assets/drag_scroll.gif" width="800" alt="Hover Banner"/>
</p>

- **Drag it to the left**: expose the table of content that also tracks your annotations
<p align="center">
<img src="assets/tree_demo.gif" width="800" alt="Hover Banner"/>
</p>

Everything you need for focused reading stays right under your fingertip.

### 3. Split Window Mode

Sometimes you gotta wonder, PDFs are longer than codes, so why isn't there a split window mode for most PDF readers?

Hover enables split window mode for a single document.
No more jumping between experiment results and metrics or figures and methodologies, enjoy doubling your reading speed without wasting time on scrolling around.

<p align="center">
<img src="assets/split_window_demo.png" width="800" alt="Hover Banner"/>
</p>

### 4. Full Dark Mode

Pulling an all-nighter reading papers sounds fun, especially when the white background lights up your entire bedroom.
With a click of the button, Hover not only turns the background in a soft dark tone, it also renders the contents black.

<p align="center">
<img src="assets/dark_mode_demo.png" width="800" alt="Hover Banner"/>
</p>

### 5. Search with Range

Not only is the search as accurate as Chrome's default reader (it's honestly awesome), it also enables you to search with a specific range that parse your range query semantically.
Section title, page number, or even "+2" (as in next 2 page) will be interpreted as a page number for ranged search.

<p align="center">
<img src="assets/search_demo.png" width="800" alt="Hover Banner"/>
</p>

### 6. Persistent Annotation

Annotations you made in this reader are embedded into the PDF document, no need for any accounts or the cloud to save annotations or to share them with others.

<p align="center">
<img src="assets/annotation_demo.png" width="800" alt="Hover Banner"/>
</p>

### 7. Direct Bibtex Access

Get bibtex and citations in other formats with just one click of a button.

<p align="center">
<img src="assets/cite_demo.png" width="800" alt="Hover Banner"/>
</p>

### 8. Appearance Customization

Customize wallpaper from image files or URLs and pick the color of the navigation ball to create your own themed PDF reading experience. (I personally find it extremely calming to use a wallpaper)

<p align="center">
<img src="assets/customize_demo.png" width="800" alt="Hover Banner"/>
</p>

### 9. VIM Motion

Full vim motion support for reading, highlighting, and citation preview (under development, currently only support HJKL).

---

## Installation & Development

Latest commit is always runnable so you can clone the repo and use npm to build and load it in Chrome.
Make sure you install the dependencies using

```bash
npm install
```

And then use

```bash
npm run build:ext
```

Open Chrome, navigate to [Chrome extension management](chrome://extensions/), turn on developer mode and load the _dist_ folder to use the extension.

Please note that we only accept PRs that do not affect the current UI.

---

## Buy Me a Coffee

If you love using Hover PDF like I do, please consider support me here:

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/chihshengj)

Every donation means a ton to me and to this project!

And if there are any bugs or possible improvements of the codebase, feel free to open an issue.

_If your team happen to be working on PDF related research or services, I'm more than glad to collaborate, please feel free to shot me an email!_

---

## Road map

- **Hover PDF for Safari**
- Touch screen support
- Building a test suite from Semantic Scholar's database
- Image/table extraction & text block analysis
- AI reading assistant (bring your own endpoint and API key) and Translation if there is a demand

---

## License

Apache 2.0 with common clause. This project will stay open sourced and free to use, commercial use of the source code is highly discouraged.

---
