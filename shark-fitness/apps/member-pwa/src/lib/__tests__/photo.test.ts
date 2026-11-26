import { describe, expect, it } from 'vitest';
import { fitWithin, PhotoPreparationError, prepareUpload } from '../photo';

describe('progress photo preparation', () => {
  it('keeps small photos as they are and scales big ones to the longest side', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });

  it('refuses anything that is not a photo before touching it', async () => {
    await expect(prepareUpload(new File(['#!/bin/sh'], 'x.jpg', { type: 'text/x-sh' }))).rejects.toBeInstanceOf(PhotoPreparationError);
  });
});
