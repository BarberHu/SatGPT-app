import { downloadMapSnapshot } from './mapSnapshot';

test('map capture downloads the same PNG filename in either mode without leaving DOM elements', () => {
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(){
  expect(this.download).toBe('satgpt-map.png');
  expect(this.href).toBe('data:image/png;base64,test');
  expect(document.body.contains(this)).toBe(true);
 });
 try {
  downloadMapSnapshot('data:image/png;base64,test');
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector('a[download]')).toBeNull();
  expect(()=>downloadMapSnapshot('data:,')).toThrow('Map capture is unavailable');
  expect(()=>downloadMapSnapshot('https://example.invalid/')).toThrow('Map capture is unavailable');
 } finally {click.mockRestore();}
});
