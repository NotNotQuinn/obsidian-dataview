
## Things happening:
Lorem ipsum (key:: Who knows?)
Lorem ipsum (key:: Same as **above**).

>[!note]+ Inline: [**status**:: Happy that this **works**!] (but it doesn't work)
>foo
>bar (foobar::Who knows?)

## Full line:

Full line:: `$= 1+1`
Full line:: This is a thing.
foo:: bar.
really_really_really_really_really_really_really_really_really_really_long_key:: value

## In-line:

Inline: [example:: foobar [[Books|link to something]] ]
Inline: (external link:: [Wikipedia](https://en.wikipedia.org/wiki/Special:Random))
[[foo]]
This has a hard time rendering: [key:: [[value as a link|alias]] ]
and so does this: [key:: [link](https://external.example.com/)]
[dlkfjghjkdfhg:: [[sdfjhksdjhfkjshdf]] ]
Thingy: [   key   ::   *va==**foobar**==lue*   ]

`$= 1+1`
>[!danger] Blocks like this always render in READER mode!!! Important for debugging.
>There is a game that goes by the [title:: "Halls of Torment"] ([released:: May 2023]), and I like it a lot. The game has (graphics:: older style) graphics, which gives it a nice feel. To play you just need a (systemRequirements:: low end) PC, and its only (price:: a few bucks) on (platform::steam). Interestingly, it was built using the (gameEngine:: Godot) game engine, which is a newer open-source alternative to the "big 2": Unity and Unreal. The game's popularity shows that you don't need to use popular frameworks to make good software.

```dataview
TABLE title,released,gameEngine,price,platform where file=this.file
```
