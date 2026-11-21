import React, { useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { publicPath } from '../utils/publicPath.js';

const tutorials = [
  {
    title: 'SATGPT Pro 2.0 Interface Overview',
    image: '/assets/help/satgpt-pro-2-0-interface-overview.png',
    width: 1920,
    height: 2736,
    alt: 'Annotated SATGPT screenshots. Static layers shows the layer library, grid selection, and a loaded water classification layer. Intelligent analysis shows conversation history, the prompt composer, and a drawn analysis area on the map.',
  },
];

function TutorialBrowser() {
  const [tutorial, setTutorial] = useState(tutorials[0]);
  const imageUrl = publicPath(tutorial.image);

  return <div className="satgpt-help-scroll" role="region" aria-label="Tutorial preview" tabIndex={0}>
    {tutorials.length > 1 && <nav className="satgpt-help-nav" aria-label="Tutorials">
      {tutorials.map(item => <button key={item.image} type="button" aria-pressed={item === tutorial}
        onClick={() => setTutorial(item)}>{item.title}</button>)}
    </nav>}
    <article>
      <div className="satgpt-help-tutorial-heading">
        <h3>{tutorial.title}</h3>
        <a href={imageUrl} target="_blank" rel="noopener noreferrer">Open full-size image</a>
      </div>
      <img className="satgpt-help-image" src={imageUrl} width={tutorial.width} height={tutorial.height} alt={tutorial.alt} />
    </article>
  </div>;
}

export default function WorkspaceHelp() {
  return <Dialog.Root>
    <Dialog.Trigger asChild>
      <button type="button" className="satgpt-toolbar-button" aria-label="Help" title="Help">
        <CircleHelp size={20} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="satgpt-help-overlay" />
      <Dialog.Content className="satgpt-help-dialog" aria-describedby={undefined}>
        <div className="satgpt-help-header">
          <Dialog.Title>SATGPT User Guide</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="satgpt-toolbar-button" aria-label="Close help">
              <X size={20} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>
        <TutorialBrowser />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
