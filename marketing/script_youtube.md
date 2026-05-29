**Script for Youtube Marketing**

Hey guys welcome to my channel! My name is Jin and I'm an independent developer. In this video I'm gonna introduce an app that I made over the last couple months, which is a browser extension -- Hover PDF.

Hover PDF is a next generation PDF reader designed for immersive academic reading.
It has a basic onboarding process the first time you install it on your computer, but in this video I'm gonna talk in detail about some of the powerful features and some tricks that have not been covered by the onboarding tutorial to help you get familiar with the UI system even more.

[Open the chrome web store]
We'll start with the installation. As you can see, Hover PDF is available in Chrome Web Store and it is now in still Beta testing, so we would love to hear the opinions from our first batch of users to help us improve!
A safari version will be out soon, please stay tuned to this channel for updates!

[Install the extension]

[Move to https://arxiv.org/abs/2501.19393]

Now I have an arxiv paper here, let's open it with Hover.

Yeah now we're in.

Hover PDF is designed to be a replacement for the default PDF reader in Chrome, so after installation, you'll notice most of the PDF files you access in the browser would be opened via Hover. Thus, it would be super helpful if you could pin Hover PDF's icon to the menu bar here since you can toggle it on and off easily to disable and enable Hover PDF.

[Toggle off]

Wow you can see it got redirected to the default pdf reader.

And let's turn it back on for now and then refresh.

[Toggle on and refresh]

and you can import local documents in the popup as well. For some academic websites, Hover will be overridden by their own reader, you can click the "Open Current Tab In Hover" button to try to open it, but this feature is still in active testing.



Let's walk through this example paper here.
The default theme of this reader is just like the preview reader in safari, we have the progress bar on the left 

[Scroll and show animation]

Yeah and you can see there's animation marking your progress dynamically

And the navigation hub on the right, yeah, I'm talking about the ball over there.

Let's first start with the most important feature. And this is the reason why I made this app, which is the citation preview.

Hover your mouse over a citation, and there, you can see the reference right at the spot.
What's more convenient is that if you wanna see the abstract of the reference, simply click the abstract button and it'll pull the abstract from google scholar immediately. And you can click the title to jump straight to the paper.

[Open a number-indexed paper]
More importantly, it works for most citation formats, so if there is a wide range of citations like this, it will show all the citations in that range

[Hover over a ranged citation]

Or a nature paper with superscript citations, it just works!

[Open a superscript paper]

It even works on papers without the internal links.

[Open a document with unformatted paper]

[Open the paper in default reader show there is no internal links]

So if we click view original in the file menu, you can open the paper in the default reader, and you can see there's no internal links in this paper.

Right now, it supports most of the citation formats and works wonders with papers with embeded internal links. I'm always actively testing out different paper formats, but it would be extremely helpful if you could report failures to me through the google questionnaire here using the feedback.

[show the feedback form in about]



[Move to the original paper]
Now let's getting into the fun part - the UI.
I designed this UI from scratch cuz I just don't like how utilitarian most pdf readers' UIs are these days.
I really want something I can enjoy while I'm reading the papers and something that makes sitting on an office chair and looking into the screen a more pleasant experience.

At left you can see the progress bar.
The ticks on the progress bar represents the sections of the paper, so you can see the progress with more of a nuance. And if you don't like it, you can just turn it off in the settings.

The navigation hub is where the magic happens.
If you're like me who grew up with the red dot on your thinkpad, it's kind of a nostalgia cuz it works the same way.
You can drag it vertically to scroll the document, and it will adjust its speed dynamically.
Some of you might have noticed the arrows at the top and the bottom, they are the jump zones.
If you move your mouse to them while dragging the ball, it takes you to the top and bottom instantly, which is super convenient for long papers.

If you double click the ball, a popup will appear, if you click the arrow button immediately, it'll take you to the top, but if you put in a number in the input box, it'll take you to the specific page.



You might have been wondering where the buttons you see in normal pdf readers are hiding.
Well they'll come out after you right click the ball.

We have rotate, split mode, and spread mode at the top, and fit-screen, zoom in and out at the bottom.
Rotate is useful when you're reading a paper with a horizontal table like this:
[Open a paper with a horizontal paper]

And double click the rotate button to restore to the original direction.

Split mode enables a split view for the paper you're reading.
The split mode even has it's own dedicated UI.

First, drag the crevice between two pane sto adjust the width of each pane.

Each time the split mode is activated, there is only one active pane that is being controlled by the navigation ball, you can use the navigation on that active pane like you would in normal mode.

The active pane is indicated by the blue progress bar around the controller, so the other pane you use for reference would not be scrolled by accident.

You can also find drag/select toggle in the tool bar, where you can toggle the drag mode and drag to move the page around.

OK now let's quit split mode and talk about spread mode.

[Quit split mode and point to the spread mode button]
Just like other PDF readers, the spread mode allows you to read the paper in even pairs, odd pairs, and no pairs, which is just the normal single page mode.

[click through modes]

You can click through them to switch the spread mode like I did to accomodate your paper or to your liking.

And at the bottom we have the fit screen button and zoom in/out
They just work like any other PDF readers, for the fit button, you click once and it would switch from fit screen width to fit screen height, but you can also just use your touchpad or command/ctrl +/- to zoom in and out easily.



Now, let's drag the navigation ball to the left
[Drag ball to the left to expose the navigation tree]

As you can see, this is a file explorer representation for the paper outlines.

You can check out a sub-tree by simply hovering over a section title, and you can also pin the expansion by clicking the arrow. And you can click on an title to move to the corresponding section.

[click an item to move to it]

As you can tell, we don't have the thumbnails for each page, but I believe this outline system can help you move around more easily.

[Close navigation tree, select a line of text]



Now let's take a look at the annotation system


If you want to make an annotation, you can select the text and hover your mouse on the floating ball to open the toolbar, select a color or a style between highlight and underline.
You can also make comments anchored at that line.

[Make a comment]

And you can see it immediately at the right side of the screen.

[Open navigation tree]
One cool thing about the annotation system is that they will be reflected in the navigation tree instantly, so you can also use it as a bookmark or an anchor of sort.

[Close navigation tree]
Another greatest thing about the annotations is that they are embeded into the pdf file once you export them from Hover.
So if you use Preview or other reader to open it, or share it to your friends and colleagues, they can also see them as is! This feature is completely local and doesn't ask you to sign into any account.
But it is still recommended to open them in Hover PDF for the native editing experience.



Next let's talk about the search
Press command/ctrl + F or the search action button on the top right corner to open the search bar
[Open search bar]
Apart from the standard search feature, Hover also allows you to search with a range.
As you can see, there are two fields, from and to, that allows you to pick a section or input a page number in order to create a search range.

You can move between the fields solely by your keyboard, select current page as the range start, and either type in a page number, select a section, or type "+3" for the next three pages from the range start!

And then you can move around the search highlights by pressing enter

Once you find what you're looking for, click the close button on the left or press escape to close the search bar.

[Close search bar]

Now let's talk about something more interesting.
Sometimes I feel like the pure color grey-ish background is too sterile and it really gives me anxiety when reading the papers, so now you can choose your own wallpaper for the pdf reader!

Let's open the settings to see what we've got here.
[Open settings]
As you can see, apart from the default wallpapers, you can also add your own wall paper to the collection from image files or urls.
I recommend something sharper than 4k to make it visually more appealing.

On top of that, you can also modify the color of the navigation hub to make the color scheme of the ball fits the background.
For example,

[Open up the EVA-02 wallpaper]
Here we have a wallpaper with Evangelion No.2, pretty sick, now let's change the ball into a gradient from red to yellow like the No.2's color scheme.
And here you go, another Evangelion collab that costs nothing!
Anyways, the customization possibilities are endless and you can upload any image you want to make it truely feel like home every time you open up a paper.

[Switch to default]
And if you're working late in a dark environment, our night mode sets the entire paper to black with a higher constrast.

[toggle night mode, point to the nearest citation]
And every UI element has been designed with a customized dark theme to have a clear display in the night mode to help you get through your all nighters writing research proposals.

[toggle back to light mode]

Now let's talk about some of the quality of life features.

[Hover to the search button]

As you can see, there are two arrows around the search button, that's because it's not just for search, it's an action tool button that can be switched to other tools. The second action tool is line drawing.

[Click line drawing tool]

Once clicked, you can draw smooth lines with the same color scheme as the annotations have, and these line drawings are also annotations that can be saved to the exported pdfs.

Let's switch to crop tool

[Click crop tool]

This tool gives you a crop region for image sharing. 

Select a region, and it would be rendered at high resolution so you can use it for presentation or social media. I wanna say thank you to one of my friends for this amazing idea!

[Open settings]

And you can also set the default tool to any one of them to access them more easily, and there are more tools to come, like translation, and AI features.



Next, you can see there is a faint handle on the left side of the window.

Let's first open up a paper through citation preview.

[Select a paper through abstract and jump to it]

Now we've moved to another paper through the citation, let's toggle the handle, we can see there is a trail created from the original paper to the current paper.

This is our paper trail system, it automatically tracks the trail you traverse while exploring the papers from one to other in a tree.

[Scroll to another trail]

It saves up to 8 trails and automatically deletes the oldest ones.

[Toggle the star trail]

But you can also star a trail to keep it from being removed.

And of course you can open up the papers on the trail easily.

The Paper trail system is still an experimental feature and might have bugs, but I'm actively improving it.

[Close trail system]

Now, I know I'm stretching it a bit too long here, but there is one last thing I wanna talk about -- the citation tool!

Open the file menu and click cite, and it will fetch citations in all formats, including bibtex directly from google scholar!

Like here

[Points to the bibtex]

And if you prefer Zotero, sadly there is no way to circumvent the fact that zotero does not work with other extensions.
So click the "view original" button, and it will show the file in the default pdf reader, where you can port the paper into your zotero library easily.

[close to a default ]
So this is Hover PDF, an immersive academic PDF reader that lives in your browser, now in beta testing.
This project will remain open sourced and free to use forever, and you can check it out on my github.

If you come across any issues using it, please fill out the feedback questionaire in the about section or in the popup, or contact me directly through email.

I've been using Hover PDF for a while now, and it simply works amazing for my workflow, and I hope you can give it a try as well.
Thank you!    

   
