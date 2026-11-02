import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';

/** Shared attachment surface; composer stays empty until uploads are supported. */
export default function AttachmentList({ items = [] }) {
  if (!items.length) return null;
  return <div className="agent-attachments" aria-label="附件与预览">
    {items.map(item => <Dialog key={item.id}>
      <DialogTrigger asChild><button type="button" className="agent-attachment" aria-label={`查看 ${item.name}`}>
        <img className="harness-preview" src={item.url} alt={item.name} loading="lazy" />
        <span><ImageIcon size={15} />{item.name}</span>
      </button></DialogTrigger>
      <DialogContent className="agent-preview-dialog">
        <DialogTitle>{item.name}</DialogTitle>
        <DialogDescription>由 Google Earth Engine 生成的影像预览</DialogDescription>
        <img src={item.url} alt={item.name} />
      </DialogContent>
    </Dialog>)}
  </div>;
}
