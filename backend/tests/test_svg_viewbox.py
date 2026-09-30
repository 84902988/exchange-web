import pytest

from app.services.svg_viewbox import normalize_svg_viewbox


def test_fixed_pixel_svg_scales_without_changing_its_artwork():
    original = b'<!-- logo --><svg width="56" height="56" xmlns="http://www.w3.org/2000/svg"><path d="M12 26h32v16" fill="#fff"/></svg>'
    result = normalize_svg_viewbox(original)
    assert result == original.replace(b'<svg ', b'<svg viewBox="0 0 56 56" ', 1)
    assert normalize_svg_viewbox(result) == result


def test_dimensions_with_pixel_units_and_comments():
    original = b'<?xml version="1.0"?><!-- <svg width="1"> --><svg width="56px" height="28.5px"/>'
    assert normalize_svg_viewbox(original) == original.replace(b'<svg width="56px"', b'<svg viewBox="0 0 56 28.5" width="56px"')


@pytest.mark.parametrize('source', [
    b'<svg width="56" height="56" viewBox="-10 -10 80 80"/>',
    b'<svg width="100%" height="56"/>',
    b'<svg height="56"/>',
    b'<svg width="0" height="56"/>',
    b'<svg width="-1" height="56"/>',
    b'<svg width="56em" height="56"/>',
    b'<svg width="56"',
    b'not an SVG',
])
def test_existing_viewbox_or_ambiguous_dimensions_are_preserved(source):
    assert normalize_svg_viewbox(source) == source
