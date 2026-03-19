**Script for Youtube Marketing**

Hey guys welcome to my channel! My name is Jin and I'm an independent developer. In this video I'm gonna introduce an app that I made over the last three months, which is a browser extension -- Hover PDF.

Hover PDF is a next generation PDF reader designed for immersive academic reading.
It has a basic onboarding process the first time you install it on your computer, but in this video I'm gonna talk in detail about the powerful features and some tricks that have not been covered by the onboarding process to help you understand the UI even more.

[Open the chrome web store]
We'll start with the installation. As you can see, Hover PDF is available on Chrome Web Store and it is now in Beta testing, so we would love to hear the opinions from our first batch of users to help us improve!
For safari users...
[Open safari extension store]

You can find the extension in app store as well, and it works equally well as the chrome version thanks to the easy conversion made possible by Apple.

[Install the extension]
Once Installed, you can see the Hover PDF icon in the extension bar, it would be super helpful if you pin it to the bar since you can toggle it on and off easily to diable and enable it, and import local documents in the popup as well.
Hover PDF is designed to replace the default PDF reader for academic reading, so it will listen to the type of documents you opened in the background and try to open the pdfs when the type matches, just like the default PDF reader does.
In fact, it only starts working when the default reader starts working, and it is a perfect replacement for people like me who uses the browser to browse academic papers a lot. And it is entirely safe as it works entirely locally and does not send any information to any servers.

Let's walk through an example here.
[Open Google Scholar]
Lots of new papers to look at here, let's open up this one for example.
You can see Hover starts to download the document immediately just like the default reader does.

Now as I've mentioned, the first time you opened this app, there would be an onboarding tutorial, but today we're using the express pass and skip it for now.
The default theme of this reader is just like the preview reader in safari, we have the progress bar on the left and the navigation hub on the right, yeah, I'm talking about the ball over there.

Let's first start with the most important feature. And this is the reason why I made this app.
Before making this app, I usually just read paper in the default pdf reader, and to see the reference behind every citation, you have to jump straight to the bottom of a paper then go back, which is an atrosity to your reading flow.
And yes I did not know the existence of Google Scholar PDF back then and I kind of designed this feature from first principle.
But I believe we have so much more to offer than them and I hope you can stick around to see why.

So first, the app parse and links all citations automatically to the references after loading the paper.
Hover your mouse over a citation, and there, you can see the reference right at the spot.
What's more convenient is that if you wanna see the abstract of the reference, simply click the abstract button and it'll pull the abstract from google scholar immediately. And you can click the title to jump straight to the paper.

[Open a number-indexed paper]
More importantly, it works for most citation formats, so if there is a wide range of citations like this

[Hover over a ranged citation]

Or a nature paper with superscript citations, it just works!

[Open a superscript paper]

It even works on papers without the internal links or compiled in microsoft word

[Open a document with unformatted paper]

[Open the paper in default reader show there is no internal links]

Right now, it supports most of the citation formats and works wonders with papers with embeded internal links, but we'll improve the parsing precision during the beta testing phase so it can handle any academic fields in the future.

[Move to the original paper]
Now let's getting into the fun part - UI.
I designed this UI from scratch cuz I just don't like how utilitarian most pdf readers' UIs are these days.
I really want something I can enjoy while I'm reading the papers and make sitting at an office chair and looking into the screen a more pleasant experience.

At left you can see the progress bar.
The ticks on the progress bar represents the sections of the paper, so you can see the progress with more of a nuance. And if you don't like it, you can just turn it off in the settings.

The navigation hub is where the magic happens.
If you're like me who grew up with the red dot on your thinkpad, it's kind of a nostalgia cuz it works the same way.
You can drag it vertically to scroll the document, and it will adjust its speed dynamically.
Some of you might have noticed the arrows at the top and the bottom, they are the jump buttons.
If you move your mouse to them while dragging the ball, it will take you to the top and bottom instantly, which is super convenient for long papers.
Also, you can double-click the ball to jump straight to the top of the paper.

And for vim users, your HJKL and gg works as well here.
Use hjkl to move like you normally would and use shift JK to scroll to next and previous page.
More vim motions will be supported in the future if the community grows.



You might wonder where the buttons you see in normal readers are hiding.
Well they'll come out after you right click the ball.

We have rotate, split mode, and spread mode at the top, and fit-screen, zoom in and out at the bottom.
Rotate is useful when you're reading a paper with a horizontal table like this:
[Open a paper with a horizontal paper]

And double click the rotate button to restore to the original direction.

Split mode enables a split view for the paper you're reading, so now you can read the appendix and the main content, or the experiment design and the results at the same time.
The split mode even has it's own dedicated UI.

First, drag the crevice between two pane sto adjust the width of each pane.

Each time the split mode is activated, there is only one active pane that is being controlled by the navigation ball, you can use the navigation on that active pane like you would in normal mode.
The blue progress indicator also indicates the active pane, so the other pane you use for reference would not be scrolled by accident.

You can also find drag/select toggle in the tool bar, where you can toggle the drag mode and drag to move the page around.

OK now let's quit split mode and talk about spread mode.

[Quit split mode and point to the spread mode button]
Just like other PDF readers, the spread mode allows you to read the paper in even pairs, odd pairs, and no pairs, which is just the normal single page mode.

[click through modes]

You can click through them to switch the spread mode like I did to accomodate your paper or to your liking.

And at the bottom we have the fit screen button and zoom in/out
They just work like any other PDF readers, for the fit button, you click once and it would switch from fit screen width to fit screen height, but you can also just use your touchpad or command/ctrl +/- to zoom in and out easily.

Now, let's drag the navigation hub to the left
[Drag ball to the left to expose the navigation tree]

As you can see, this is a tree for the paper outlines, it can be either embeded or parsed by our parsing module, so the results may vary.

You can check a sub-tree by simply hovering over an item, and you can also pin the expansion of the item by clicking the arrow. And click on an item to move to it.

[click an item to move to it]

As you can tell, we don't have the thumbnails for each page, but I believe this system can help you move more quickly through the paper.

Now let's take a look at the annotation system
[Close navigation tree, select a line of text]

If you want to make an annotation, you can select the text and hover your mouse on the floating ball to open the toolbar, select a color or a style between highlight and underline.
You can also make comments anchored at that line.

[Make a comment]

And you can see it immediately at the right side of the screen.

[Open navigation tree]
The annotations will be reflected in the navigation tree instantly, so you can also use it as a bookmark or an anchor of sort.

[Close navigation tree]
The greatest thing about the annotations is that they are embeded into the pdf file once you saved them.
So if you use Preview or other reader to open it, or share it to your friends and colleagues, they can also see them as is!
But it is still recommended to open them in Hover PDF for the native experience. After all it is only a 5MB package and if you don't like it, you can just remove it.

Next let's talk about the search
Press command/ctrl + F to open the search bar
[Open search bar]

Thanks to the PDFium core under the hood, the search quality is just as good as the default PDF reader, which is much under appreciated and amazing by itself.
We take this one step further by allowing you to search with a range.
As you can see, there are two fields, from and to, that allows you to pick a section or input a page number in order to create a search range.

You can move between the fields solely by your keyboard, select current page as the range start, and either type in a page number, select a section, or type "+3" for the next three pages from the range start!

And then you can move around the search highlights by pressing enter

Once you find what you're looking for, click the close button on the left or press escape to close the search bar.

[Close search bar]

Now let's talk about something more interesting.
Sometimes I feel like the pure color grey-ish background is too sterile and it really gives me anxiety when reading the papers, so now you can choose your own wallpaper for the pdf reader!

Let's open the settings to see what we've got here.
[Open settings]
As you can see, apart from the default papers, you can also add your own wall paper to the collection from image files or urls.
I recommend something sharper than 4k to make it visually more appealing.

On top of that, you can also modify the color of the navigation hub to make the color scheme of the ball fits the background.
For example,

[Open up the EVA-02 wallpaper]
Here we have a wallpaper with Evangelion No.2, pretty sick, now let's change the ball into a gradient from red to yellow like the No.2's color scheme.
And here you go, another Evangelion collab that costs nothing!
Anyways, the customization possibilities are endless and you can upload any image you want to make it truely feel like home every time you open up a paper.

[Switch to default]
And if you're working late in a dark environment, our night mode sets the entire paper background to black with a higher constrast.

[toggle night mode]
And every UI element has been designed with a customized dark theme to have a clear display in the night mode to help you get through your all nighters writing the research proposal.

[toggle back to light mode]
Now, I know I'm stretching it a bit too long here, so there is one last thing I wanna talk about -- the citation!

Open the file menu and click cite, and it will fetch citations in all formats, including bibtex directly from google scholar!

Like here

[Points to the bibtex]

And if you prefer Zotero, sadly there is no way to circumvent the fact that zotero does not work with other extensions.
So click the "view original" button, and it will show the file in the default pdf reader, where you can port the paper into your zotero library easily.

[close to a default ]
So this is Hover PDF, an immersive academic PDF reader that lives in your browser, now in beta testing.
This project will remain open sourced and free to use forever, and you can check it out on my github.

If you come across any issues using it, please fill out the feedback questionaire in the about section or the popup, or contact me directly through email.

I've been using Hover PDF for a while now, and it simply works amazing, and I hope you can give it a try as well.
Thank you!
