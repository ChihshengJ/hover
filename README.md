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
Hover solves this problem by providing a pop-up window that gives you the access to the text of the references directly, allowing you to jump directly to an ArXiv paper, or search the title with Google.

The project is based on PDF.js, which means that you can also directly access the texts as html elements, if you're interested in taking advantage of this feature, feel free to fork it!

---

## Features

### Inline Citation Preview

Hover's main purpose is to solve the problem of LaTeX citation links that direct you straight to the references when reading most scientific papers.
This process is highly disruptive to the flow of reading, but hard to tackle with in practice since the hyperlink in LaTeX usually only contains the positional information within the document.
Hover solves this problem by heuristically parsing the PDF annotations and finding the text content of the citation.
Just hover your mouse on the citation link, the content of the citation would appear right at the spot.
You can even directly open up the URL in the citation or search the title of cited document in Google.

### Floating Ball Navigation

PDF readers are boring as hell.
Hover introduces a small but beautifully designed floating ball that acts as your navigation hub.

- **Drag it vertically**: scroll the document
- **Single click**: go to the previous page
- **Double click**: go to the next page
- **Left click**: open the full mini toolbar which includes functionalities such as **dark mode**, **split window**, **fit-width**, **horizontal spread**, **zoom in/out**, and **Highlighter**.

The functionalities are kept at their minimum, but your interaction with the document is more fluid than ever.

### Split window mode

Sometimes you gotta wonder, PDFs are longer than codes, so why isn't there a split window mode for most PDF readers?
With Hover, you can enable split window mode to view the two parts of the document at the same time.
No more jumping between experiment results and metrics or figures and methodologies, enjoy doubling your reading speed without wasting time on scrolling around.

### Full Dark mode

Pulling an all-nighter reading papers sounds fun, especially when the white background lights up your entire bedroom.
With a click of the button, Hover not only turns the background dark, it also renders the page in a soft black tone with white texts.

### VIM motion

Full vim motion support for reading, highlighting, and citation preview (currently under development).

---

## Installation

This project will be released as a browser extension.

Latest commit is always runnable so you can clone the repo and use npm to run it as a demo locally.
Make sure you install the dependencies using

```bash
npm install
```

And then use

```bash
npm run dev
```

To start the service.
Open <http://localhost:5173/?file={append the URL to the file here}> in Chrome and it should be running.

---

## Road map (Short Term)

- Improve robustness for various academic papers.
- Mobile version
- Better zooming and smoother scroll handling
- Configurable citation preview styling
- Accommodation for Lefties
- Theme configuration

---

## License

MIT

---
