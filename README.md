<p align="center">
  <img src="assets/IMG_3047.jpeg" width="240" alt="Hover Banner"/>
</p>

<h1 align="center">Hover — A Super Lightweight PDF Viewer Extension</h1>

<p align="center">
  <img src="assets/H.png" width="120" alt="Hover Icon"/>
</p>

Hover is a minimalist PDF reader extension designed for people who spend way too much time reading academic papers in the browser.
It intentionally keeps only the most essential features, but aims to make the actual _experience_ of reading papers smoother, faster, and immersive by ---

You've guessed it: **Hopping between the content and the references**  
Hover solves that with inline citation preview popups that appear exactly where your cursor hovers, and lets you jump directly to the referenced paper in a new tab with one click.

The project is based on PDF.js, which means that you can also directly access the texts as html elements, if you're interested in taking advantage of this feature, feel free to fork it!

---

## Features

### Inline Citation Preview

Hover's main objective is to solve the LaTeX citation link that jumps between the content and the reference in most scientific papers.
This process is highly disruptive of the flow of reading, but hard to tackle with in practice since the hyperlink in LaTeX usually only contains the position information within the document.
Hover solves this problem by heuristically parse the PDF annotation and finds the text content of the citation.
Just hover your mouse on the citation link, the content of the citation would appear right at the spot.
You can even directly open up the URL in the citation or search the title of cited document in Google.

### Floating Ball Navigation

PDF reader are boring as hell.
Hover introduces a small but beautifully designed floating ball that acts as your navigation hub.

- **Drag it vertically**: scroll the document
- **Single click**: go to the **previous page**
- **Double click**: go to the **next page**
- **Left click**: open the full mini toolbar which includes functionalities such as **dark mode**, **split window**, **fit-width**, **horizontal spread**, **zoom in/out**, and **Highlighter**.

The functionalities are kept at their minimum, but your interaction with the document is more fluid than ever.

### Split window

Sometimes you gotta wonder, PDFs are longer than codes, so why isn't there a split window mode for most PDF readers?
Hover's got you covered! You can enable split mode to view the two parts of the document at the same time.
No more jumping between experiment results and metrics or figures and methodologies, enjoy doubling your reading speed without wasting time on scrolling around.

### Full Dark mode

Pulling an all-nighter reading papers? Sounds fun!
With a click of the button, hover not only turns the background dark, it also renders the page in a soft black tone with white texts.

---

## Installation

This project will be released as a browser extension.

---

## 🚧 Roadmap (Short Term)

- Improve robustness for various academic papers.
- Mobile version
- Better zooming and smoother scroll handling
- Configurable citation preview styling
- Accommodation for Lefties
- Theme configuration

---

## 📝 License

MIT

---
