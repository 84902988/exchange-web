"""Preserve SVG artwork while allowing fixed-size icons to scale on mobile."""
from __future__ import annotations

import re
from decimal import Decimal
from xml.etree import ElementTree


def normalize_svg_viewbox(content: bytes) -> bytes:
    """Infer a missing viewBox only from explicit positive pixel dimensions."""
    try:
        root = ElementTree.fromstring(content)
    except (ElementTree.ParseError, ValueError):
        return content
    if root.tag not in {'svg', '{http://www.w3.org/2000/svg}svg'} or 'viewBox' in root.attrib:
        return content
    dimensions = []
    for name in ('width', 'height'):
        match = re.fullmatch(r'\s*((?:\d+(?:\.\d*)?|\.\d+))(?:px)?\s*', root.get(name, ''))
        if not match or Decimal(match[1]) <= 0:
            return content
        dimensions.append(match[1])
    # Skip declarations/comments so a commented-out <svg> is never modified.
    opening = re.match(rb'(?:\xef\xbb\xbf)?\s*(?:(?:<\?.*?\?>|<!--.*?-->)\s*)*<svg(?=[\s/>])', content, re.DOTALL)
    if opening is None:
        return content
    attribute = (' viewBox="0 0 ' + ' '.join(dimensions) + '"').encode('ascii')
    return content[:opening.end()] + attribute + content[opening.end():]
